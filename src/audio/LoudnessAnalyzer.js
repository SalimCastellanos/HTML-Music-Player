import {moduleEvents} from "wasm/WebAssemblyWrapper";
const maxHistoryMs = 8000;
const windowMs = 400;
const windowS = windowMs / 1000;

export default class LoudnessAnalyzer {
    constructor(wasm, channelCount, sampleRate) {
        this._maxHistoryMs = maxHistoryMs;
        this._sampleRate = sampleRate;
        this._channelCount = channelCount;
        this._wasm = wasm;
        this._ptr = 0;
        this._establishedGain = -1;
        this._previousGain = NaN;
        this._framesAdded = 0;
        this._windowIndex = 0;

        const [err, ptr] = this.loudness_analyzer_init(channelCount, sampleRate, maxHistoryMs);
        if (err) {
            throw new Error(`ebur128 error ${err} ${channelCount} ${sampleRate} ${maxHistoryMs}`);
        }
        this._ptr = ptr;
    }

    getLoudness(samplePtr, audioFrameCount) {
        if (!this._ptr) {
            throw new Error(`not allocated`);
        }

        let err = this.loudness_analyzer_add_frames(this._ptr, samplePtr, audioFrameCount);
        if (err) {
            throw new Error(`ebur128 error ${err} ${samplePtr} ${audioFrameCount}`);
        }

        const windowIndex = this._windowIndex;
        this._framesAdded += audioFrameCount;
        const currentWindowIndex = Math.floor(this._framesAdded / this._sampleRate / windowS);

        if (currentWindowIndex > windowIndex) {
            this._windowIndex = currentWindowIndex;

            const [err, gain] = this.loudness_analyzer_get_gain(this._ptr);
            if (err) {
                throw new Error(`ebur128 error ${err} ${samplePtr} ${audioFrameCount}`);
            }

            this._previousGain = gain;

            if (!this.hasEstablishedGain()) {
                const neededFrames = Math.ceil(this._maxHistoryMs / 1000 * this._sampleRate);
                if (this._framesAdded >= neededFrames) {
                    this._establishedGain = gain;
                }
            }

            return gain;
        } else {
            return this._previousGain;
        }
    }

    hasEstablishedGain() {
        return this._establishedGain !== -1;
    }

    getEstablishedGain() {
        return this._establishedGain;
    }

    destroy() {
        if (this._ptr) {
            this.loudness_analyzer_destroy(this._ptr);
            this._ptr = 0;
        }
    }

    reset() {
        if (!this._ptr) {
            throw new Error(`not allocated`);
        }
        this._establishedGain = -1;
        this._framesAdded = 0;
        this._windowIndex = 0;
        this._previousGain = NaN;
        const err = this.loudness_analyzer_reset(this._ptr);
        if (err) {
            throw new Error(`ebur128: reset error ${err}`);
        }
    }

    reinitialized(channelCount, sampleRate) {
        this._channelCount = channelCount;
        this._sampleRate = sampleRate;
        this._establishedGain = -1;
        this._framesAdded = 0;
        this._windowIndex = 0;
        this._previousGain = NaN;
        if (!this._ptr) {
            const [err, ptr] = this.loudness_analyzer_init(channelCount, sampleRate, this._maxHistoryMs);
            if (err) {
                throw new Error(`ebur128 error ${err} ${channelCount} ${sampleRate} ${this._maxHistoryMs}`);
            }
            this._ptr = ptr;
        } else {
            const err = this.loudness_analyzer_reinitialize(this._ptr, channelCount, sampleRate, this._maxHistoryMs);
            if (err) {
                throw new Error(`ebur128 error ${err} ${channelCount} ${sampleRate} ${this._maxHistoryMs}`);
            }
        }
        return this;
    }
}



moduleEvents.on(`main_afterInitialized`, (wasm, exports) => {
    LoudnessAnalyzer.prototype.loudness_analyzer_init = wasm.createFunctionWrapper({
        name: `loudness_analyzer_init`,
        unsafeJsStack: true
    }, `integer`, `integer`, `integer`, `integer-retval`);
    LoudnessAnalyzer.prototype.loudness_analyzer_get_gain = wasm.createFunctionWrapper({
        name: `loudness_analyzer_get_gain`,
        unsafeJsStack: true
    }, `integer`, `double-retval`);
    LoudnessAnalyzer.prototype.loudness_analyzer_destroy = exports.loudness_analyzer_destroy;
    LoudnessAnalyzer.prototype.loudness_analyzer_reinitialize = exports.loudness_analyzer_reinitialize;
    LoudnessAnalyzer.prototype.loudness_analyzer_reset = exports.loudness_analyzer_reset;
    LoudnessAnalyzer.prototype.loudness_analyzer_add_frames = exports.loudness_analyzer_add_frames;
});
