// Audio player implemented using AudioBuffers. Tracks are resampled and mixed
// Manually to hardware specs to guarantee seamless playback between consecutive
// Audiobuffers.
import {inherits, throttle, roundSampleTime} from "util";
import {AudioContext, ArrayBuffer, Float32Array,
        Blob, File, console, performance} from "platform/platform";
import EventEmitter from "events";
import {PLAYER_READY_EVENT_NAME} from "audio/AudioPlayerBackend";
import WorkerFrontend from "WorkerFrontend";
import {BUFFER_FILL_TYPE_SEEK,
        BUFFER_FILL_TYPE_REPLACEMENT} from "audio/AudioSource";

const NO_THROTTLE = {};
const EXPENSIVE_CALL_THROTTLE_TIME = 100;
const TARGET_BUFFER_LENGTH_SECONDS = 0.4;
const SUSTAINED_BUFFERED_AUDIO_SECONDS = 2.5;
const SUSTAINED_BUFFER_COUNT = Math.ceil(SUSTAINED_BUFFERED_AUDIO_SECONDS / TARGET_BUFFER_LENGTH_SECONDS);
const MIN_BUFFERS_TO_REQUEST = Math.ceil(SUSTAINED_BUFFER_COUNT / 4);
const SCHEDULE_AHEAD_RATIO = 0.75;
const FLOAT32_BYTES = 4;
const SUSPEND_AUDIO_CONTEXT_AFTER_SECONDS = 20;
const WEB_AUDIO_BLOCK_SIZE = 128;

if (!AudioContext.prototype.suspend) {
    AudioContext.prototype.suspend = function() {
        return Promise.resolve();
    };
}
if (!AudioContext.prototype.resume) {
    AudioContext.prototype.resume = function() {
        return Promise.resolve();
    };
}

const decibelToGain = function(loudness) {
    return Math.pow(10, (loudness / 20));
};

class SourceDescriptor {
    constructor(sourceNode, buffer, descriptor, channelData, isLastForTrack) {
        this._sourceNode = sourceNode;
        this.buffer = buffer;
        this.playedSoFar = 0;
        this.startTime = descriptor.startTime;
        this.endTime = descriptor.endTime;
        this.length = descriptor.length;
        this.duration = descriptor.length / buffer.sampleRate;
        this._gain = isNaN(descriptor.loudness) ? NaN : decibelToGain(descriptor.loudness);
        this.started = -1;
        this.source = null;
        this.channelData = channelData;
        this.isLastForTrack = isLastForTrack;
    }

    get gain() {
        return isNaN(this._gain) ? this._sourceNode._baseGain : this._gain;
    }

    getRemainingDuration() {
        return this.duration - this.playedSoFar;
    }
}

function NativeGetOutputTimestamp() {
    return this._audioContext.getOutputTimestamp();
}

function PolyfillGetOutputTimestamp() {
    return {
        contextTime: this._audioContext.currentTime,
        performanceTime: performance.now()
    };
}

let autoIncrementNodeId = 0;
export default class AudioPlayer extends WorkerFrontend {
    constructor(deps) {
        super(PLAYER_READY_EVENT_NAME, deps.workerWrapper);
        this.page = deps.page;
        this.env = deps.env;
        this.db = deps.db;
        this.timers = deps.timers;
        this.dbValues = deps.dbValues;
        this.crossfadingPreferences = deps.crossfadingPreferences;
        this.effectPreferences = deps.effectPreferences;
        this.applicationPreferences = deps.applicationPreferences;

        this._audioContext = null;
        this._unprimedAudioContext = null;
        this._silentBuffer = null;
        this._previousAudioContextTime = -1;
        this._outputSampleRate = -1;
        this._outputChannelCount = -1;
        this._scheduleAheadTime = -1;
        this._arrayBufferPool = [];
        this._audioBufferPool = [];
        this._sourceNodes = [];
        this._bufferFrameCount = 0;
        this._playedAudioBuffersNeededForVisualization = 0;
        this._arrayBufferByteLength = 0;
        this._maxAudioBuffers = 0;
        this._maxArrayBuffers = 0;
        this._audioBufferTime = -1;
        this._audioBuffersAllocated = 0;
        this._arrayBuffersAllocated = 0;
        this._suspensionTimeoutMs = SUSPEND_AUDIO_CONTEXT_AFTER_SECONDS * 1000;
        this._currentStateModificationAction = null;
        this._lastAudioContextRefresh = 0;

        this._playbackStoppedTime = performance.now();

        this._suspend = this._suspend.bind(this);

        this._suspensionTimeoutId = this.page.setTimeout(this._suspend, this._suspensionTimeoutMs);
        this._hardwareLatency = 0;

        this.effectPreferences.on(`change`, async () => {
            await this.ready();
            this.setEffects(this.effectPreferences.getAudioPlayerEffects());
        });

        this._updateBackendConfig({resamplerQuality: this._determineResamplerQuality()});
        this.page.addDocumentListener(`touchend`, this._touchended.bind(this), true);

        this.getOutputTimestamp = typeof AudioContext.prototype.getOutputTimestamp === `function` ? NativeGetOutputTimestamp
                                                                                                  : PolyfillGetOutputTimestamp;
        this._resetAudioContext();
        this._initBackend();
    }
}

AudioPlayer.prototype.receiveMessage = function(event) {
    const {nodeId} = event.data;
    if (nodeId >= 0) {
        for (let i = 0; i < this._sourceNodes.length; ++i) {
            if (this._sourceNodes[i]._id === nodeId) {
                this._sourceNodes[i].receiveMessage(event);
                break;
            }
        }
    } else {
        const {methodName, args, transferList} = event.data;
        if ((nodeId < 0 || nodeId === undefined) && methodName) {
            this[methodName](args, transferList);
        }
    }
};

AudioPlayer.prototype._bufferFrameCountForSampleRate = function(sampleRate) {
    return TARGET_BUFFER_LENGTH_SECONDS * sampleRate;
};

AudioPlayer.prototype._updateBackendConfig = async function(config) {
    await this.ready();
    this._message(-1, `audioConfiguration`, config);
};

AudioPlayer.prototype._initBackend = async function() {
    await this.ready();
    this.setEffects(this.effectPreferences.getAudioPlayerEffects());
};

AudioPlayer.prototype._audioContextChanged = async function() {
    const {_audioContext} = this;
    const {channelCount} = _audioContext.destination;
    const {sampleRate} = _audioContext;

    this._previousAudioContextTime = _audioContext.currentTime;

    if (this._setAudioOutputParameters({channelCount, sampleRate})) {
        this._bufferFrameCount = this._bufferFrameCountForSampleRate(sampleRate);
        this._audioBufferTime = this._bufferFrameCount / sampleRate;
        this._playedAudioBuffersNeededForVisualization = Math.ceil(0.5 / this._audioBufferTime);
        this._maxAudioBuffers = SUSTAINED_BUFFER_COUNT * 2 + this._playedAudioBuffersNeededForVisualization;
        this._maxArrayBuffers = (this._maxAudioBuffers * channelCount * (channelCount + 1)) +
            (SUSTAINED_BUFFER_COUNT + this._playedAudioBuffersNeededForVisualization) * channelCount;
        this._arrayBufferByteLength = FLOAT32_BYTES * this._bufferFrameCount;

        this._silentBuffer = _audioContext.createBuffer(channelCount, this._bufferFrameCount, sampleRate);
        await this._updateBackendConfig({channelCount, sampleRate, bufferTime: this._audioBufferTime});
        this._resetPools();
        for (const sourceNode of this._sourceNodes.slice()) {
            sourceNode._resetAudioBuffers();
        }
    } else {
        for (const sourceNode of this._sourceNodes.slice()) {
            sourceNode.adoptNewAudioContext(_audioContext);
        }
    }
};

AudioPlayer.prototype._setAudioOutputParameters = function({sampleRate, channelCount}) {
    let changed = false;
    if (this._outputSampleRate !== sampleRate) {
        this._outputSampleRate = sampleRate;
        changed = true;
    }
    if (this._outputChannelCount !== channelCount) {
        this._outputChannelCount = channelCount;
        changed = true;
    }
    this._scheduleAheadTime = Math.max(this._scheduleAheadTime,
                                       roundSampleTime(WEB_AUDIO_BLOCK_SIZE * 12, sampleRate) / sampleRate);
    return changed;
};

AudioPlayer.prototype.getScheduleAheadTime = function() {
    return this._scheduleAheadTime;
};

AudioPlayer.prototype.recordSchedulingTime = function(elapsedMs) {
    const seconds = elapsedMs / 1000;
    const scheduleAheadTime = this._scheduleAheadTime;
    if (seconds * SCHEDULE_AHEAD_RATIO > scheduleAheadTime) {
        const sampleRate = this._outputSampleRate;
        let minScheduleAheadSamples = seconds * (1 / SCHEDULE_AHEAD_RATIO) * sampleRate;
        minScheduleAheadSamples = Math.ceil(minScheduleAheadSamples / WEB_AUDIO_BLOCK_SIZE) * WEB_AUDIO_BLOCK_SIZE;
        this._scheduleAheadTime = roundSampleTime(minScheduleAheadSamples, sampleRate) / sampleRate;
        console.warn(`increased _scheduleAheadTime from ${scheduleAheadTime} to ${this._scheduleAheadTime} because operation took ${elapsedMs.toFixed(0)} ms`);
    }
};

AudioPlayer.prototype._touchended = async function() {
    if (this._unprimedAudioContext) {
        const audioCtx = this._unprimedAudioContext;
        try {
            await audioCtx.resume();
        } catch (e) {
            // Noop
        }

        const source = audioCtx.createBufferSource();
        source.buffer = this._silentBuffer;
        source.connect(audioCtx.destination);
        source.start(0);
        this._unprimedAudioContext = null;
    }
};

AudioPlayer.prototype._suspend = function() {
    if (this._audioContext.state === `suspended`) return Promise.resolve();

    if (!this._currentStateModificationAction) {
        this._currentStateModificationAction = {
            type: `suspend`,
            promise: (async () => {
                try {
                    await Promise.resolve(this._audioContext.suspend());
                } finally {
                    this._currentStateModificationAction = null;
                }
            })()
        };
        return this._currentStateModificationAction.promise;
    } else if (this._currentStateModificationAction.type === `resume`) {
        this._currentStateModificationAction.promise = (async () => {
            try {
                try {
                    await this._currentStateModificationAction.promise;
                } finally {
                    await this._suspend();
                }
            } finally {
                this._currentStateModificationAction = null;
            }
        })();
    }
    return this._currentStateModificationAction.promise;
};

AudioPlayer.prototype._resetAudioContext = function() {
    try {
        if (this._audioContext) {
            this._audioContext.close();
        }
    } catch (e) {
        // NOOP
    } finally {
        this._audioContext = null;
    }
    this._audioContext = new AudioContext({latencyHint: `playback`});
    this._unprimedAudioContext = this._audioContext;
    this._audioContextChanged();
    this.emit(`audioContextReset`, this);
};

AudioPlayer.prototype._clearSuspensionTimer = function() {
    this._playbackStoppedTime = -1;
    this.page.clearTimeout(this._suspensionTimeoutId);
    this._suspensionTimeoutId = -1;
};

AudioPlayer.prototype._message = function(nodeId, methodName, args, transferList) {
    if (transferList === undefined) transferList = [];
    args = Object(args);
    transferList = transferList.map((v) => {
        if (v.buffer) return v.buffer;
        return v;
    });
    this.postMessage({
        nodeId,
        methodName,
        args,
        transferList
    }, transferList);
};

AudioPlayer.prototype._freeTransferList = function(args, transferList) {
    if (!transferList) return;

    while (transferList.length > 0) {
        let item = transferList.pop();
        if (!(item instanceof ArrayBuffer)) {
            item = item.buffer;
        }
        if (item.byteLength > 0) {
            this._freeArrayBuffer(item);
        }
    }
};

AudioPlayer.prototype._resetPools = function() {
    this._audioBuffersAllocated = 0;
    this._arrayBuffersAllocated = 0;
    this._audioBufferPool = [];
    this._arrayBufferPool = [];
};

AudioPlayer.prototype._freeAudioBuffer = function(audioBuffer) {
    if (audioBuffer.sampleRate === this._outputSampleRate &&
        audioBuffer.numberOfChannels === this._outputChannelCount &&
        audioBuffer.length === this._bufferFrameCount) {
        this._audioBufferPool.push(audioBuffer);
    }
};

AudioPlayer.prototype._allocAudioBuffer = function() {
    if (this._audioBufferPool.length > 0) return this._audioBufferPool.shift();
    const {_outputChannelCount, _outputSampleRate, _bufferFrameCount, _audioContext} = this;
    const ret = _audioContext.createBuffer(_outputChannelCount, _bufferFrameCount, _outputSampleRate);
    this._audioBuffersAllocated++;
    if (this._audioBuffersAllocated > this._maxAudioBuffers) {
        console.warn(`Possible memory leak: over ${this._maxAudioBuffers} audio buffers allocated`);
    }
    return ret;
};

AudioPlayer.prototype._freeArrayBuffer = function(arrayBuffer) {
    if (!(arrayBuffer instanceof ArrayBuffer)) {
        arrayBuffer = arrayBuffer.buffer;
    }

    if (arrayBuffer.byteLength === this._arrayBufferByteLength) {
        this._arrayBufferPool.push(arrayBuffer);
    }
};

AudioPlayer.prototype._allocArrayBuffer = function(size) {
    if (this._arrayBufferPool.length) return new Float32Array(this._arrayBufferPool.shift(), 0, size);
    this._arrayBuffersAllocated++;
    if (this._arrayBuffersAllocated > this._maxArrayBuffers) {
        console.warn(`Possible memory leak: over ${this._maxArrayBuffers} array buffers allocated`);
    }
    const buffer = new ArrayBuffer(this._arrayBufferByteLength);
    return new Float32Array(buffer, 0, size);
};

const LOWEST = 2;
const DESKTOP = 4;
AudioPlayer.prototype._determineResamplerQuality = function() {
    return this.env.isMobile() ? LOWEST : DESKTOP;
};

AudioPlayer.prototype._sourceNodeDestroyed = function(node) {
    const i = this._sourceNodes.indexOf(node);
    if (i >= 0) this._sourceNodes.splice(i, 1);
};

AudioPlayer.prototype.getMaxLatency = function() {
    return this._bufferFrameCount / this._outputSampleRate / 2;
};

AudioPlayer.prototype.getHardwareLatency = function() {
    return this._hardwareLatency;
};

AudioPlayer.prototype.setHardwareLatency = function(amount) {
    amount = +amount;
    if (!isFinite(amount)) return;
    amount = Math.min(this.getMaxLatency(), Math.max(amount, 0));
    this._hardwareLatency = amount;
};

AudioPlayer.prototype.getCurrentTime = function() {
    return this._audioContext.currentTime;
};

AudioPlayer.prototype.getAudioContext = function() {
    return this._audioContext;
};

AudioPlayer.prototype.resume = function() {
    if (this._audioContext.state === `running`) {
        if (this._playbackStoppedTime !== -1 &&
            performance.now() - this._playbackStoppedTime > this._suspensionTimeoutMs) {
            this._playbackStoppedTime = -1;
            this.emit(`audioContextSuspend`, this);
            this._resetAudioContext();
        }
        return;
    }

    // Reset AudioContext as it's probably ruined despite of suspension efforts.
    if (!this._currentStateModificationAction) {
        this._resetAudioContext();
    } else if (this._currentStateModificationAction.type === `suspend`) {
        this._currentStateModificationAction = null;
        this._resetAudioContext();
    }

};

AudioPlayer.prototype.playbackStopped = function() {
    this._clearSuspensionTimer();
    this._playbackStoppedTime = performance.now();
    this._suspensionTimeoutId = this.page.setTimeout(this._suspend, this._suspensionTimeoutMs);
};

AudioPlayer.prototype.playbackStarted = function() {
    this._clearSuspensionTimer();
};

AudioPlayer.prototype.getMaximumSeekTime = function(duration) {
    return Math.max(0, duration - (this._audioBufferTime + (2048 / this._audioContext.sampleRate)));
};

AudioPlayer.prototype.getBufferDuration = function() {
    return this._audioBufferTime;
};

AudioPlayer.prototype.createSourceNode = function() {
    const ret = new AudioPlayerSourceNode(this, autoIncrementNodeId++, this._audioContext);
    this._sourceNodes.push(ret);
    return ret;
};

AudioPlayer.prototype.ping = function() {
    this.timers.tick();
    this.postMessage({
        nodeId: -1,
        args: {},
        methodName: `ping`
    });
};

AudioPlayer.prototype.setEffects = function(spec) {
    if (!Array.isArray(spec)) spec = [spec];
    this.postMessage({
        nodeId: -1,
        args: {
            effects: spec
        },
        methodName: `setEffects`
    });
};

function AudioPlayerSourceNode(player, id, audioContext) {
    EventEmitter.call(this);
    this._id = id;
    this._sourceEndedId = 0;
    this._seekRequestId = 0;
    this._replacementRequestId = 0;

    this._lastExpensiveCall = 0;

    this._player = player;
    this._audioContext = audioContext;
    this._haveBlob = false;
    this._sourceStopped = true;
    this._normalizerNode = audioContext.createGain();
    this._volume = 1;
    this._muted = false;
    this._loadingNext = false;

    this._currentTime = 0;
    this._baseTime = 0;
    this._duration = 0;

    this._paused = true;
    this._destroyed = false;
    this._baseGain = 1;

    this._initialPlaythroughEmitted = false;
    this._currentSeekEmitted = false;
    this._lastBufferLoadedEmitted = false;
    this._endedEmitted = false;

    this._previousAudioContextTime = -1;
    this._previousHighResTime = -1;
    this._previousCombinedTime = -1;

    this._gaplessPreloadArgs = null;

    this._timeUpdate = this._timeUpdate.bind(this);
    this._sourceEnded = this._sourceEnded.bind(this);
    this._ended = this._ended.bind(this);

    this._timeUpdater = this.page().setInterval(this._timeUpdate, 32);
    this._player._message(-1, `register`, {
        id: this._id
    });

    this._bufferQueue = [];
    this._playedBufferQueue = [];
}
inherits(AudioPlayerSourceNode, EventEmitter);

AudioPlayerSourceNode.prototype.page = function() {
    return this._player.page;
};

AudioPlayerSourceNode.prototype.destroy = function() {
    if (this._destroyed) return;
    this.removeAllListeners();
    this.page().clearInterval(this._timeUpdater);
    this.unload();
    this._player._sourceNodeDestroyed(this);
    try {
        this._normalizerNode.disconnect();
    } catch (e) {
        // NOOP
    }
    this._normalizerNode = null;
    this._audioContext = null;
    this._timeUpdate =
    this._sourceEnded =
    this._ended = null;
    this._destroyed = true;
    this._player._message(this._id, `destroy`);
};

AudioPlayerSourceNode.prototype.adoptNewAudioContext = function(audioContext) {
    if (!this._sourceStopped) {
        throw new Error(`sources must be stopped while adopting new audio context`);
    }
    this._audioContext = audioContext;
    this._normalizerNode = audioContext.createGain();
    this._previousAudioContextTime = -1;
    this._previousHighResTime = -1;
    this._previousCombinedTime = -1;

    if (this._bufferQueue.length > 0) {
        this._bufferQueue[0].started = audioContext.currentTime - this._bufferQueue[0].playedSoFar;
        for (let i = 1; i < this._bufferQueue.length; ++i) {
            const prev = this._bufferQueue[i - 1];
            this._bufferQueue[i].started = prev.started + prev.duration;
        }
    }
};

AudioPlayerSourceNode.prototype._getCurrentAudioBufferBaseTimeDelta = function(now) {
    const sourceDescriptor = this._bufferQueue[0];
    if (!sourceDescriptor) return 0;
    if (now === undefined) now = this._player.getCurrentTime();
    const {started} = sourceDescriptor;
    if (now < started || started > (sourceDescriptor.started + sourceDescriptor.duration)) {
        return 0;
    }

    if (this._paused || this._sourceStopped) return 0;
    return Math.min((now - started) + sourceDescriptor.playedSoFar, this._player.getBufferDuration());
};

AudioPlayerSourceNode.prototype._nullifyPendingRequests = function() {
    this._seekRequestId++;
    this._replacementRequestId++;
    this._player._message(this._id, `cancelAllOperations`);
};

AudioPlayerSourceNode.prototype._timeUpdate = function() {
    if (this._destroyed || this._loadingNext) return;
    const currentBufferPlayedSoFar = this._getCurrentAudioBufferBaseTimeDelta();
    const currentTime = this._baseTime + currentBufferPlayedSoFar;
    this._currentTime = this._haveBlob ? Math.min(this._duration, currentTime) : currentTime;
    this._emitTimeUpdate(this._currentTime, this._duration);
};

AudioPlayerSourceNode.prototype._ended = function() {
    if (this._endedEmitted || this._destroyed || this._loadingNext) return;

    this._player.playbackStopped();
    this._endedEmitted = true;

    if (this.hasGaplessPreload()) {
        this._currentTime = this._duration;
        this._emitTimeUpdate(this._currentTime, this._duration, true);
        this.emit(`ended`, true);
        return;
    }
    this._nullifyPendingRequests();
    this._currentTime = this._duration;
    this._stopSources();

    let sourceDescriptor;
    while (sourceDescriptor = this._bufferQueue.shift()) {
        this._destroySourceDescriptor(sourceDescriptor);
    }

    this._emitTimeUpdate(this._currentTime, this._duration, true);
    this.emit(`ended`, false);
};

AudioPlayerSourceNode.prototype._destroySourceDescriptor = function(sourceDescriptor, stopTime = -1) {
    if (sourceDescriptor.buffer === null) return;
    sourceDescriptor._sourceNode = null;
    const src = sourceDescriptor.source;
    if (src) {
        src.descriptor = null;
        src.onended = null;

        if (stopTime !== -1) {
            try {
                src.stop(stopTime);
            } catch (e) {
                // NOOP
            }
        }

        try {
            src.disconnect();
        } catch (e) {
            // NOOP
        }
        sourceDescriptor.source = null;
    }
    this._player._freeAudioBuffer(sourceDescriptor.buffer);
    for (let i = 0; i < sourceDescriptor.channelData.length; ++i) {
        this._player._freeArrayBuffer(sourceDescriptor.channelData[i]);
    }
    sourceDescriptor.buffer = null;
    sourceDescriptor.channelData = null;
};

AudioPlayerSourceNode.prototype._sourceEnded = function(descriptor, source) {
    try {
        if (!descriptor) {
            console.warn(new Date().toISOString(), `!descriptor`,
                            `ended emitted`, this._endedEmitted,
                            `length`, this._bufferQueue.length);
            return;
        }

        const {length} = this._bufferQueue;
        let sourceDescriptor = null;
        if (length > 0 && this._bufferQueue[0] === descriptor) {
            sourceDescriptor = this._bufferQueue.shift();
        } else {
            for (let i = 0; i < this._playedBufferQueue.length; ++i) {
                if (this._playedBufferQueue[i] === descriptor) {
                    for (let j = i; j < this._playedBufferQueue.length; ++j) {
                        this._destroySourceDescriptor(this._playedBufferQueue[j]);
                    }
                    this._playedBufferQueue.length = i;
                    return;
                }
            }
        }

        if (!sourceDescriptor) {
            this._destroySourceDescriptor(descriptor);
            console.warn(new Date().toISOString(), `!sourceDescriptor`,
                         `ended emitted`, this._endedEmitted,
                         `prelen`, length,
                         `postlen`, this._bufferQueue.length,
                         `referencedStart`, descriptor.startTime,
                         `referencedEnd`, descriptor.endTime);
            this._ended();
            return;
        }

        if (sourceDescriptor !== descriptor) {
            console.warn(new Date().toISOString(), `sourceDescriptor !== descriptor`,
                         `ended emitted`, this._endedEmitted,
                         `prelen`, length,
                         `postlen`, this._bufferQueue.length,
                         `queuedStart`, sourceDescriptor.startTime,
                         `queuedEnd`, sourceDescriptor.endTime,
                         `referencedStart`, descriptor.startTime,
                         `referencedEnd`, descriptor.endTime);
            this._destroySourceDescriptor(descriptor);
            this._destroySourceDescriptor(sourceDescriptor);
            this._ended();
            return;
        }
        this._baseTime += sourceDescriptor.duration;

        source.descriptor = null;
        source.onended = null;
        sourceDescriptor.source = null;
        this._playedBufferQueue.push(sourceDescriptor);
        while (this._playedBufferQueue.length > this._player._playedAudioBuffersNeededForVisualization) {
            this._destroySourceDescriptor(this._playedBufferQueue.shift());
        }

        if (this._baseTime >= this._duration ||
            (sourceDescriptor.isLastForTrack && this._bufferQueue.length === 0)) {
            this._ended();
            return;
        }
    } finally {
        this._player.ping();
        this._requestMoreBuffers();
        if (this._timeUpdate) {
            this._timeUpdate();
        }
    }
};

AudioPlayerSourceNode.prototype._lastSourceEnds = function() {
    if (this._sourceStopped) throw new Error(`sources are stopped`);
    if (this._bufferQueue.length === 0) return this._player.getCurrentTime();
    const sourceDescriptor = this._bufferQueue[this._bufferQueue.length - 1];
    return sourceDescriptor.started + sourceDescriptor.getRemainingDuration();
};

AudioPlayerSourceNode.prototype._startSource = function(sourceDescriptor, when) {
    if (this._destroyed) return -1;
    const {buffer} = sourceDescriptor;
    const duration = sourceDescriptor.getRemainingDuration();
    const src = this._audioContext.createBufferSource();
    let endedEmitted = false;
    sourceDescriptor.source = src;
    sourceDescriptor.started = when;
    src.buffer = buffer;
    src.connect(this.node());
    try {
        this._normalizerNode.gain.setValueAtTime(sourceDescriptor.gain, when);
    } catch (e) {
        console.warn(e.stack);
    }
    src.start(when, sourceDescriptor.playedSoFar);
    src.stop(when + duration);
    src.onended = () => {
        if (endedEmitted) return;
        endedEmitted = true;
        src.onended = null;
        this._sourceEnded(sourceDescriptor, src);
    };

    return when + duration;
};

AudioPlayerSourceNode.prototype._startSources = function(when) {
    if (this._destroyed || this._paused) return;
    if (!this._sourceStopped) throw new Error(`sources are not stopped`);
    this._sourceStopped = false;
    for (let i = 0; i < this._bufferQueue.length; ++i) {
        when = this._startSource(this._bufferQueue[i], when);
    }

    if (!this._initialPlaythroughEmitted) {
        this._initialPlaythroughEmitted = true;
        this.emit(`initialPlaythrough`);
    }
};

AudioPlayerSourceNode.prototype._stopSources = function(when = this._player.getCurrentTime(),
                                                        destroyDescriptorsThatWillNeverPlay = false) {
    if (this._destroyed) return;
    this._player.playbackStopped();

    this._sourceStopped = true;
    try {
        this._normalizerNode.gain.cancelScheduledValues(when);
    } catch (e) {
        console.warn(e.stack);
    }

    for (let i = 0; i < this._bufferQueue.length; ++i) {
        const sourceDescriptor = this._bufferQueue[i];
        if (destroyDescriptorsThatWillNeverPlay && (sourceDescriptor.started === -1 ||
            sourceDescriptor.started > when)) {
            for (let j = i; j < this._bufferQueue.length; ++j) {
                this._destroySourceDescriptor(this._bufferQueue[j], when);
            }
            this._bufferQueue.length = i;
            return;
        }
        const src = sourceDescriptor.source;
        if (!src) continue;
        if (when >= sourceDescriptor.started &&
            when < sourceDescriptor.started + sourceDescriptor.duration) {
            sourceDescriptor.playedSoFar += (when - sourceDescriptor.started);
        }
        src.onended = null;

        try {
            src.stop(when);
        } catch (e) {
            // NOOP
        }
    }
};

const MAX_ANALYSER_SIZE = 65536;
// When visualizing audio it is better to visualize samples that will play right away
// Rather than what has already been played.
AudioPlayerSourceNode.prototype.getUpcomingSamples = function(input) {
    if (this._destroyed) return false;
    if (!(input instanceof Float32Array)) throw new Error(`need Float32Array`);
    let samplesNeeded = Math.min(MAX_ANALYSER_SIZE, input.length);
    const inputBuffer = input.buffer;

    if (!this._sourceStopped) {
        const timestamp = this._player.getOutputTimestamp();
        let now = timestamp.contextTime;
        const hr = timestamp.performanceTime;
        const prevHr = this._previousHighResTime;

        // Workaround for bad values from polyfill
        if (now === this._previousAudioContextTime) {
            const reallyElapsed = Math.round(((hr - prevHr) * 1000)) / 1e6;
            now += reallyElapsed;
            this._previousCombinedTime = now;
        } else {
            this._previousAudioContextTime = now;
            this._previousHighResTime = hr;
        }

        if (now < this._previousCombinedTime) {
            now = this._previousCombinedTime + Math.round(((hr - prevHr) * 1000)) / 1e6;
        }

        let samplesIndex = 0;
        const bufferQueue = this._bufferQueue;
        const playedBufferQueue = this._playedBufferQueue;
        const latency = this._player.getHardwareLatency();

        if (bufferQueue.length === 0) {
            return false;
        }

        const buffers = [bufferQueue[0]];
        const {sampleRate} = this._audioContext;
        const offsetInCurrentBuffer = this._getCurrentAudioBufferBaseTimeDelta(now);

        if (Math.ceil((offsetInCurrentBuffer + (samplesNeeded / sampleRate) - latency) * sampleRate) > buffers[0].length &&
            bufferQueue.length < 2) {
            return false;
        } else {
            buffers.push(bufferQueue[1]);
        }

        if (offsetInCurrentBuffer < latency && playedBufferQueue.length === 0) {
            return false;
        } else {
            buffers.unshift(playedBufferQueue.length > 0 ? playedBufferQueue[0] : null);
        }

        const bufferIndex = offsetInCurrentBuffer >= latency ? 1 : 0;
        let bufferDataIndex = bufferIndex === 0 ? (buffers[0].length - ((latency * sampleRate) | 0)) + ((offsetInCurrentBuffer * sampleRate) | 0)
                                                : ((offsetInCurrentBuffer - latency) * sampleRate) | 0;

        for (let i = bufferIndex; i < buffers.length; ++i) {
            const j = bufferDataIndex;
            const buffer = buffers[i];
            const samplesRemainingInBuffer = Math.max(0, buffer.length - j);
            if (samplesRemainingInBuffer <= 0) {
                bufferDataIndex = 0;
                continue;
            }
            const byteLength = buffer.channelData[0].buffer.byteLength - j * 4;
            const fillCount = Math.min(samplesNeeded, samplesRemainingInBuffer, (byteLength / 4) | 0);
            const {channelData, gain} = buffer;
            const sampleViews = new Array(channelData.length);
            for (let ch = 0; ch < sampleViews.length; ++ch) {
                sampleViews[ch] = new Float32Array(channelData[ch].buffer, j * 4, fillCount);
            }
            const dst = new Float32Array(inputBuffer, samplesIndex * 4, samplesNeeded);

            if (sampleViews.length === 2) {
                for (let k = 0; k < fillCount; ++k) {
                    dst[k] = Math.fround((sampleViews[0][k] + sampleViews[1][k]) / 2 * gain);
                }
            } else if (sampleViews.length === 1) {
                const src = sampleViews[0];
                for (let k = 0; k < fillCount; ++k) {
                    dst[k] = Math.fround(src[k] * gain);
                }
            } else {
                // TODO Support more than 2 channels.
                return false;
            }
            samplesIndex += fillCount;
            samplesNeeded -= fillCount;

            if (samplesNeeded <= 0) {
                return true;
            }
            bufferDataIndex = 0;
        }
        return false;
    } else {
        for (let i = 0; i < input.length; ++i) {
            input[i] = 0;
        }
        return true;
    }
};

AudioPlayerSourceNode.prototype._getBuffersForTransferList = function(count) {
    const buffers = new Array(this._audioContext.destination.channelCount * count);
    const size = this._audioContext.sampleRate * this._player._audioBufferTime;
    for (let i = 0; i < buffers.length; ++i) {
        buffers[i] = this._player._allocArrayBuffer(size);
    }
    return buffers;
}
;
AudioPlayerSourceNode.prototype._requestMoreBuffers = function() {
    if (!this._haveBlob || this._destroyed) return;
    if (this._bufferQueue.length < SUSTAINED_BUFFER_COUNT) {
        const count = SUSTAINED_BUFFER_COUNT - this._bufferQueue.length;
        if (count >= MIN_BUFFERS_TO_REQUEST) {
            this._player._message(this._id, `fillBuffers`, {
                count
            }, this._getBuffersForTransferList(count));
        }
    }
};

AudioPlayerSourceNode.prototype._emitSeekComplete = function(scheduledStartTime) {
    this.emit(`seekComplete`, scheduledStartTime);
};

AudioPlayerSourceNode.prototype._emitReplacementLoaded = function(scheduledStartTime) {
    this.emit(`replacementLoaded`, scheduledStartTime);
};

AudioPlayerSourceNode.prototype.getCurrentTimeScheduledAhead = function() {
    return this._player.getScheduleAheadTime() + this._player.getCurrentTime();
};

AudioPlayerSourceNode.prototype._idle = function() {
    this._requestMoreBuffers();
};

AudioPlayerSourceNode.prototype._rescheduleLoudness = function() {
    let when = this.getCurrentTimeScheduledAhead();
    try {
        this._normalizerNode.gain.cancelScheduledValues(when);
    } catch (e) {
        console.warn(e.stack);
    }
    for (let i = 0; i < this._bufferQueue.length; ++i) {
        try {
            const sourceDescriptor = this._bufferQueue[i];
            let {duration} = sourceDescriptor;
            if (sourceDescriptor.playedSoFar > 0) {
                duration = sourceDescriptor.getRemainingDuration() - this._player.getScheduleAheadTime();
                if (duration < 0) {
                    continue;
                }
            }
            this._normalizerNode.gain.setValueAtTime(sourceDescriptor.gain, when);
            when += duration;
        } catch (e) {
            console.warn(e.stack);
        }
    }
};

AudioPlayerSourceNode.prototype._emitTimeUpdate = function(currentTime, duration, willEmitEnded = false) {
    this.emit(`timeUpdate`, currentTime, duration, willEmitEnded, this._endedEmitted);
};

AudioPlayerSourceNode.prototype._bufferFilled = function({descriptor, isLastBuffer, bufferFillType},
                                                         transferList) {
    try {
        if (!descriptor || this._destroyed) {
            return;
        }

        let currentSourcesShouldBeStopped = false;
        const afterScheduleKnownCallbacks = [];

        if (bufferFillType === BUFFER_FILL_TYPE_SEEK) {
            const {requestId, baseTime, isUserSeek} = descriptor.fillTypeData;

            if (requestId !== this._seekRequestId) {
                return;
            }
            currentSourcesShouldBeStopped = true;
            this._applySeek(baseTime);
            afterScheduleKnownCallbacks.push(isUserSeek ? this._emitSeekComplete : this._emitReplacementLoaded);
        } else if (bufferFillType === BUFFER_FILL_TYPE_REPLACEMENT) {
            const {metadata, gaplessPreload, requestId, baseTime} = descriptor.fillTypeData;

            if (requestId !== this._replacementRequestId) {
                return;
            }
            this._loadingNext = false;

            if (gaplessPreload) {
                afterScheduleKnownCallbacks.push((scheduledStartTime) => {
                    this._gaplessPreloadArgs = {scheduledStartTime, metadata, baseTime};
                });
            } else {
                currentSourcesShouldBeStopped = true;
                this._applyReplacementLoaded({metadata, baseTime});
                afterScheduleKnownCallbacks.push(this._emitReplacementLoaded);
            }
        }

        this._player.playbackStarted();
        this._player.resume();
        const channelCount = this._player._outputChannelCount;
        const audioBuffer = this._player._allocAudioBuffer();
        const channelData = new Array(channelCount);

        for (let ch = 0; ch < channelCount; ++ch) {
            const data = new Float32Array(transferList.shift(), 0, descriptor.length);
            audioBuffer.copyToChannel(data, ch);
            channelData[ch] = data;
        }

        const sourceDescriptor = new SourceDescriptor(this, audioBuffer, descriptor, channelData, isLastBuffer);

        if (sourceDescriptor.isLastForTrack &&
            sourceDescriptor.endTime < this._duration - this._player.getBufferDuration()) {
            this._duration = sourceDescriptor.endTime;
            this._emitTimeUpdate(this._currentTime, this._duration);
            this.emit(`durationChange`, this._duration);
        }

        if (this._baseGain === 1 && !isNaN(descriptor.loudness)) {
            this._baseGain = decibelToGain(descriptor.loudness);
            if (!currentSourcesShouldBeStopped && !this._sourceStopped) {
                this._rescheduleLoudness();
            }
        }

        let scheduledStartTime;
        const now = performance.now();
        if (currentSourcesShouldBeStopped) {
            scheduledStartTime = this.getCurrentTimeScheduledAhead();
            this._stopSources(scheduledStartTime, true);
            this._playedBufferQueue.push(...this._bufferQueue);
            this._bufferQueue.length = 0;
            this._bufferQueue.push(sourceDescriptor);
            this._startSource(sourceDescriptor, scheduledStartTime);
        } else if (this._sourceStopped) {
            this._bufferQueue.push(sourceDescriptor);
            scheduledStartTime = this.getCurrentTimeScheduledAhead();
            if (!this._paused) {
                this._startSources(scheduledStartTime);
            }
        } else {
            scheduledStartTime = this._lastSourceEnds();
            this._bufferQueue.push(sourceDescriptor);
            this._startSource(sourceDescriptor, scheduledStartTime);
        }

        for (let i = 0; i < afterScheduleKnownCallbacks.length; ++i) {
            afterScheduleKnownCallbacks[i].call(this, scheduledStartTime);
        }

        this._player.recordSchedulingTime(performance.now() - now);

        if (isLastBuffer && !this._lastBufferLoadedEmitted) {
            this._lastBufferLoadedEmitted = true;
            this.emit(`lastBufferQueued`);
        }
    } finally {
        this._freeTransferList(transferList);
    }
};

AudioPlayerSourceNode.prototype.receiveMessage = function(event) {
    const {nodeId, methodName, args, transferList} = event.data;
    if (this._destroyed) return;
    if (nodeId === this._id) {
        this[methodName](args, transferList);
    }
};

AudioPlayerSourceNode.prototype.pause = function() {
    if (this._destroyed || this._paused) return;
    this._stopSources();
    this._paused = true;
};

AudioPlayerSourceNode.prototype.resume =
AudioPlayerSourceNode.prototype.play = function() {
    if (this._destroyed || !this._paused) return;
    if (this._duration > 0 &&
        this._currentTime > 0 &&
        this._currentTime >= this._duration) {
        return;
    }
    this._paused = false;
    if (this._bufferQueue.length > 0 && this._sourceStopped && this._haveBlob) {
        this._player.playbackStarted();
        this._player.resume();
        this._startSources(this.getCurrentTimeScheduledAhead());
    }
    this._emitTimeUpdate(this._currentTime, this._duration);
};

AudioPlayerSourceNode.prototype.isMuted = function() {
    return this._muted;
};

AudioPlayerSourceNode.prototype.isPaused = function() {
    return this._paused;
};

AudioPlayerSourceNode.prototype.node = function() {
    return this._normalizerNode;
};

AudioPlayerSourceNode.prototype.getCurrentTime = function() {
    return this._currentTime;
};

AudioPlayerSourceNode.prototype.getDuration = function() {
    return this._duration;
};

AudioPlayerSourceNode.prototype._freeTransferList = function(transferList) {
    this._player._freeTransferList(null, transferList);
};

AudioPlayerSourceNode.prototype._seek = function(time, isUserSeek) {
    if (!this.isSeekable()) return;
    const requestId = ++this._seekRequestId;
    this._player._message(this._id, `seek`, {
        requestId,
        count: SUSTAINED_BUFFER_COUNT,
        time,
        isUserSeek
    }, this._getBuffersForTransferList(SUSTAINED_BUFFER_COUNT));
    if (!this._currentSeekEmitted && isUserSeek) {
        this._currentSeekEmitted = true;
        this.emit(`seeking`, this._currentTime);
    }
};

AudioPlayerSourceNode.prototype._resetAudioBuffers = function() {
    if (this.isSeekable() && this._haveBlob) {
        this.setCurrentTime(this._currentTime, true);
    } else {
        this.destroy();
    }
};

AudioPlayerSourceNode.prototype.setCurrentTime = function(time, noThrottle) {
    if (!this.isSeekable()) {
        return;
    }

    time = +time;
    if (!isFinite(time)) {
        throw new Error(`time is not finite`);
    }
    time = Math.max(0, time);
    if (this._haveBlob) {
        time = Math.min(this._player.getMaximumSeekTime(this._duration), time);
    }

    this._currentTime = time;
    this._baseTime = this._currentTime - this._getCurrentAudioBufferBaseTimeDelta();
    this._timeUpdate();

    if (!this._haveBlob || !this.isSeekable()) {
        return;
    }

    this._nullifyPendingRequests();
    if (noThrottle === NO_THROTTLE) {
        this._seek(this._currentTime, false);
    } else {
        const now = performance.now();
        if (now - this._lastExpensiveCall > EXPENSIVE_CALL_THROTTLE_TIME) {
            this._seek(this._currentTime, true);
        } else {
            this._throttledSeek(this._currentTime);
        }
        this._lastExpensiveCall = now;
    }
};

AudioPlayerSourceNode.prototype.unload = function() {
    if (this._destroyed) return;
    this._gaplessPreloadArgs = null;
    this._nullifyPendingRequests();
    this._currentTime = this._duration = this._baseTime = 0;
    this._haveBlob = false;
    this._seeking = false;
    this._initialPlaythroughEmitted = false;
    this._currentSeekEmitted = false;
    this._lastBufferLoadedEmitted = false;
    this._endedEmitted = false;
    this._stopSources();

    let sourceDescriptor;
    while (sourceDescriptor = this._bufferQueue.shift()) {
        this._destroySourceDescriptor(sourceDescriptor);
    }

    while (sourceDescriptor = this._playedBufferQueue.shift()) {
        this._destroySourceDescriptor(sourceDescriptor);
    }
};

AudioPlayerSourceNode.prototype.isSeekable = function() {
    return !(this._destroyed || this._lastBufferLoadedEmitted) && !this._loadingNext;
};

AudioPlayerSourceNode.prototype._error = function(args, transferList) {
    if (this._destroyed) {
        this._freeTransferList(transferList);
        return;
    }
    this._freeTransferList(transferList);
    const e = new Error(args.message);
    e.name = args.name;
    e.stack = args.stack;
    if (this._player.env.isDevelopment()) {
        console.error(e.stack);
    }
    this.unload();
    this.emit(`error`, e);
};

AudioPlayerSourceNode.prototype._blobLoaded = function(args) {
    if (this._destroyed) return;
    if (this._replacementRequestId !== args.requestId) return;
    const {metadata} = args;
    this._loadingNext = false;
    this._haveBlob = true;
    this._duration = metadata.duration;
    this._baseGain = typeof metadata.establishedGain === `number` ? metadata.establishedGain : 1;
    this._currentTime = Math.min(this._player.getMaximumSeekTime(this._duration), Math.max(0, this._currentTime));
    this._seek(this._currentTime, false);
    this._emitTimeUpdate(this._currentTime, this._duration);
    this.emit(`canPlay`);
};

AudioPlayerSourceNode.prototype.hasGaplessPreload = function() {
    return this._gaplessPreloadArgs !== null;
};

AudioPlayerSourceNode.prototype.replaceUsingGaplessPreload = function() {
    if (this._destroyed) return -1;
    if (!this.hasGaplessPreload()) throw new Error(`no gapless preload`);
    const args = this._gaplessPreloadArgs;
    this._gaplessPreloadArgs = null;
    this._applyReplacementLoaded(args);
    return args.scheduledStartTime;
};

AudioPlayerSourceNode.prototype._applySeek = function(baseTime) {
    if (this._destroyed) return;
    this._baseTime = baseTime;
    this._currentSeekEmitted = false;
    this._lastBufferLoadedEmitted = false;
    this._endedEmitted = false;
    this._timeUpdate();
};

AudioPlayerSourceNode.prototype._applyReplacementLoaded = function({metadata, baseTime}) {
    if (this._destroyed) return;
    this._duration = metadata.duration;
    this._baseGain = typeof metadata.establishedGain === `number` ? metadata.establishedGain : 1;
    this._applySeek(baseTime);
};

AudioPlayerSourceNode.prototype._actualReplace = function(blob, seekTime, gaplessPreload, metadata) {
    if (this._destroyed) return;
    if (!this._haveBlob) {
        this.load(blob, seekTime, metadata);
        return;
    }

    this._gaplessPreloadArgs = null;
    this._endedEmitted = false;

    if (seekTime === undefined) {
        seekTime = 0;
    }
    const requestId = ++this._replacementRequestId;
    this._player._message(this._id, `loadReplacement`, {
        blob,
        requestId,
        seekTime,
        count: SUSTAINED_BUFFER_COUNT,
        gaplessPreload: !!gaplessPreload,
        metadata
    }, this._getBuffersForTransferList(SUSTAINED_BUFFER_COUNT));
};


// Seamless replacement of current track with the next.
AudioPlayerSourceNode.prototype.replace = function(blob, seekTime, gaplessPreload, metadata) {
    if (this._destroyed) return;
    if (seekTime === undefined) seekTime = 0;
    this._loadingNext = true;
    const now = performance.now();
    if (now - this._lastExpensiveCall > EXPENSIVE_CALL_THROTTLE_TIME) {
        this._actualReplace(blob, seekTime, gaplessPreload, metadata);
    } else {
        this._replaceThrottled(blob, seekTime, gaplessPreload, metadata);
    }
    this._lastExpensiveCall = now;
};

AudioPlayerSourceNode.prototype._actualLoad = function(blob, seekTime, metadata) {
    if (this._destroyed) return;
    if (seekTime === undefined) {
        seekTime = 0;
    }

    this.unload();
    this._currentTime = this._baseTime = seekTime;
    const fillRequestId = ++this._replacementRequestId;
    this._player._message(this._id, `loadBlob`, {
        blob,
        requestId: fillRequestId,
        metadata
    });
};

AudioPlayerSourceNode.prototype.load = function(blob, seekTime, metadata) {
    if (this._destroyed) return;
    if (seekTime === undefined) seekTime = 0;
    if (!(blob instanceof Blob) && !(blob instanceof File)) {
        throw new Error(`blob must be a blob`);
    }
    this._nullifyPendingRequests();
    const now = performance.now();
    this._loadingNext = true;
    if (now - this._lastExpensiveCall > EXPENSIVE_CALL_THROTTLE_TIME) {
        this._actualLoad(blob, seekTime, metadata);
    } else {
        this._loadThrottled(blob, seekTime, metadata);
    }
    this._lastExpensiveCall = now;
};

AudioPlayerSourceNode.prototype._throttledSeek = function(time) {
    this._seek(time, true);
};

AudioPlayerSourceNode.prototype._replaceThrottled = function(blob, seekTime, gaplessPreload, metadata) {
    this._actualReplace(blob, seekTime, gaplessPreload, metadata);
};

AudioPlayerSourceNode.prototype._loadThrottled = function(blob, seekTime, metadata) {
    this._actualLoad(blob, seekTime, metadata);
};

AudioPlayerSourceNode.prototype._throttledSeek = throttle(AudioPlayerSourceNode.prototype._throttledSeek,
        EXPENSIVE_CALL_THROTTLE_TIME);
AudioPlayerSourceNode.prototype._loadThrottled = throttle(AudioPlayerSourceNode.prototype._loadThrottled,
        EXPENSIVE_CALL_THROTTLE_TIME);
AudioPlayerSourceNode.prototype._replaceThrottled = throttle(AudioPlayerSourceNode.prototype._replaceThrottled,
        EXPENSIVE_CALL_THROTTLE_TIME);
