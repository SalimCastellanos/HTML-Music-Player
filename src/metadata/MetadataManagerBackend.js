import getCodecName from "audio/backend/sniffer";
import FileView from "platform/FileView";
import parseMp3Metadata from "metadata/mp3_metadata";
import parseAcoustId from "metadata/acoustId";
import AbstractBackend from "AbstractBackend";
import JobProcessor, {JOB_COMPLETE_EVENT} from "utils/JobProcessor";
import {delay, sha1Binary, queryString,
        toCorsUrl, _, trackInfoFromFileName, ajaxGet} from "util";
import getCodec from "audio/backend/codec";
import {URL, Blob} from "platform/platform";
import {allocResampler, freeResampler} from "audio/backend/pool";
import ChannelMixer from "audio/backend/ChannelMixer";
import AudioProcessingPipeline from "audio/backend/AudioProcessingPipeline";
import Fingerprinter from "audio/backend/Fingerprinter";
import {MAX_BUFFER_LENGTH_SECONDS as BUFFER_DURATION} from "audio/frontend/buffering";

export const JOB_STATE_INITIAL = `initial`;
export const JOB_STATE_DATA_FETCHED = `dataFetched`;
export const METADATA_MANAGER_READY_EVENT_NAME = `metadataManagerReady`;
export const ALBUM_ART_RESULT_MESSAGE = `albumArtResult`;
export const ACOUST_ID_DATA_RESULT_MESSAGE = `acoustIdDataFetched`;
export const METADATA_RESULT_MESSAGE = `metadataResult`;
export const ALBUM_ART_PREFERENCE_SMALLEST = `smallest`;
export const ALBUM_ART_PREFERENCE_BIGGEST = `biggest`;
export const ALBUM_ART_PREFERENCE_ALL = `all`;

export const METADATA_UPDATE_EVENT = `metadataUpdate`;

export const getFileCacheKey = function(file) {
    return sha1Binary(`${file.lastModified}-${file.name}-${file.size}-${file.type}`);
};

const NO_JOBS_FOUND_TOKEN = {};
const JOBS_FOUND_TOKEN = {};

const MAX_BLOB_URL_SIZE = 1024 * 1024 * 2;

const IMAGE_TYPE_KEY = `imageType`;
const IMAGE_TYPE_COVERARTARCHIVE = `coverartarchive`;
const IMAGE_TYPE_BLOB = `blob`;

const imageTypeKeyWeights = {
    [IMAGE_TYPE_BLOB]: 0,
    [IMAGE_TYPE_COVERARTARCHIVE]: 1
};

const codecNotSupportedError = function() {
    const e = new Error(`codec not supported`);
    e.name = `CodecNotSupportedError`;
    return e;
};

const runknown = /^[\s<{[(]*unknown[}\])>\s]*$/i;
const isUnknown = function(value) {
    if (!value) {
        return true;
    }
    return runknown.test(`${value}`);
};

const imageDescriptionWeights = {
    Front: 0,
    Back: 1,
    Tray: 2,
    Booklet: 3,
    Medium: 4
};

function getDescriptionWeight(image) {
    if (image.description) {
        const weight = imageDescriptionWeights[image.description];
        if (typeof weight !== `number`) {
            return -1;
        }
        return weight;
    } else if (Array.isArray(image.types)) {
        const weight = imageDescriptionWeights[image.types.join(``)];
        if (typeof weight !== `number`) {
            return imageDescriptionWeights.Booklet + 1;
        }
        return weight;
    } else {
        return -1;
    }
}



function buildTrackInfo(metadata, demuxData) {
    const {title = null, album = null, artist = null, albumArtist = null,
           year = null, albumIndex = 0, trackCount = 1,
           genres = []} = metadata;
    return Object.assign({}, metadata, {
        lastPlayed: new Date(0),
        rating: -1,
        playthroughCounter: 0,
        skipCounter: 0,
        hasBeenFingerprinted: false,
        title, album, artist, albumArtist, year, albumIndex, trackCount, genres
    }, {
        sampleRate: demuxData.sampleRate,
        channels: demuxData.channels,
        duration: demuxData.duration
    });
}

export default class MetadataManagerBackend extends AbstractBackend {
    constructor(wasm, tagDatabase, _timers) {
        super(METADATA_MANAGER_READY_EVENT_NAME);
        this._tagDatabase = tagDatabase;
        this._timers = _timers;
        this._wasm = wasm;
        this._blobUrls = [];
        this._blobUrlSize = 0;

        this._acoustIdDataFetcher = new JobProcessor({delay: 1000, jobCallback: this._fetchAcoustIdDataJob.bind(this)});
        this._fingerprinter = new JobProcessor({jobCallback: this._fingerprintJob.bind(this)});
        this._metadataParser = new JobProcessor({jobCallback: this._parseMetadataJob.bind(this), parallelJobs: 8});
        this._coverArtDownloader = new JobProcessor({
            jobCallback({cancellationToken}, url) {
                return ajaxGet(toCorsUrl(url), cancellationToken, {responseType: `blob`});
            },
            parallelJobs: 3
        });

        this.actions = {
            async getAlbumArt({trackUid, artist, album, preference, requestReason}) {
                const albumArt = await this._getAlbumArt(trackUid, artist, album, preference);
                const result = {albumArt, trackUid, preference, requestReason};
                this.postMessage({type: ALBUM_ART_RESULT_MESSAGE, result});
            },

            async parseMetadata({file, uid}) {
                try {
                    const trackInfo = await this._metadataParser.postJob(file, uid).promise;
                    const result = {trackInfo, trackUid: uid};
                    this.postMessage({type: METADATA_RESULT_MESSAGE, result});
                    if (!trackInfo.hasBeenFingerprinted) {
                        this._fingerprinter.postJob(file, uid);
                    }
                } catch (e) {
                    const result = {
                        error: {
                            message: e.message
                        }
                    };
                    this.postMessage({type: METADATA_RESULT_MESSAGE, result});
                }
            }
        };
        this._acoustIdDataFetcher.on(JOB_COMPLETE_EVENT, async (job) => {
            const result = await job.promise;
            if (result !== NO_JOBS_FOUND_TOKEN) {
                this._acoustIdDataFetcher.postJob();
            }
        });
        this._acoustIdDataFetcher.postJob();
    }

    setEstablishedGain(trackUid, establishedGain) {
        return this._tagDatabase.updateEstablishedGain(trackUid, establishedGain);
    }

    async getTrackInfoByFile(file) {
        const trackUid = await getFileCacheKey(file);
        return this._tagDatabase.getTrackInfoByTrackUid(trackUid);
    }

    async _fingerprintJob({cancellationToken}, file, uid) {
        let decoder, resampler, fingerprinter, channelMixer;
        const {_tagDatabase: tagDatabase, _wasm: wasm} = this;
        try {
            const trackInfo = await tagDatabase.getTrackInfoByTrackUid(uid);

            if (!trackInfo || trackInfo.hasBeenFingerprinted) {
                return;
            }

            const DecoderContext = await getCodec(trackInfo.codecName);

            const {sampleRate, duration, channels, demuxData} = trackInfo;
            const sourceSampleRate = sampleRate;
            const sourceChannelCount = channels;
            const {dataStart, dataEnd} = demuxData;
            let fingerprint = null;

            if (duration >= 15) {
                decoder = new DecoderContext(wasm, {
                    targetBufferLengthAudioFrames: BUFFER_DURATION * sampleRate
                });
                decoder.start(demuxData);

                fingerprinter = new Fingerprinter(wasm);
                const {destinationChannelCount, destinationSampleRate, resamplerQuality} = fingerprinter;
                resampler = allocResampler(wasm,
                                           destinationChannelCount,
                                           sourceSampleRate,
                                           destinationSampleRate,
                                           resamplerQuality);
                channelMixer = new ChannelMixer(wasm, {destinationChannelCount});
                const audioPipeline = new AudioProcessingPipeline(wasm, {
                    sourceSampleRate, sourceChannelCount,
                    destinationSampleRate, destinationChannelCount,
                    decoder, resampler, channelMixer, fingerprinter,
                    bufferTime: BUFFER_DURATION,
                    bufferAudioFrameCount: destinationSampleRate * BUFFER_DURATION
                });

                const fileStartPosition = dataStart;
                let filePosition = fileStartPosition;
                const fileEndPosition = dataEnd;
                const fileView = new FileView(file);

                while (filePosition < fileEndPosition && fingerprinter.needFrames()) {
                    const bytesRead = await audioPipeline.decodeFromFileViewAtOffset(fileView,
                                                                                     filePosition,
                                                                                     demuxData,
                                                                                     cancellationToken);
                    audioPipeline.consumeFilledBuffer();
                    filePosition += bytesRead;
                }
                fingerprint = fingerprinter.calculateFingerprint();
            }

            if (fingerprint) {
                await this._tagDatabase.updateHasBeenFingerprinted(uid, true);
                await this._tagDatabase.addAcoustIdFetchJob(uid, fingerprint, duration, JOB_STATE_INITIAL);
                this._acoustIdDataFetcher.postJob();
            }
        } finally {
            if (decoder) decoder.destroy();
            if (resampler) freeResampler(resampler);
            if (fingerprinter) fingerprinter.destroy();
            if (channelMixer) channelMixer.destroy();
        }
    }

    async _fetchAcoustIdDataJob({cancellationToken}) {
        const job = await this._tagDatabase.getAcoustIdFetchJob();
        if (!job) {
            return NO_JOBS_FOUND_TOKEN;
        }

        const {trackUid, fingerprint, duration, jobId} = job;
        let {acoustIdResult, state} = job;
        let trackInfo;
        let trackInfoUpdated = false;
        const waitLongTime = !!job.lastError;

        if (state === JOB_STATE_INITIAL) {
            try {
               const result = await this._fetchAcoustId(cancellationToken, trackUid, fingerprint, duration);
                ({acoustIdResult, trackInfo, trackInfoUpdated} = result);
                await this._tagDatabase.updateAcoustIdFetchJobState(jobId, {
                    acoustIdResult: acoustIdResult || null,
                    state: JOB_STATE_DATA_FETCHED
                });

                state = JOB_STATE_DATA_FETCHED;
            } catch (e) {
                await this._tagDatabase.setAcoustIdFetchJobError(jobId, e);
                if (waitLongTime) {
                    await delay(10000);
                }
                return JOBS_FOUND_TOKEN;
            }
        }

        if (state === JOB_STATE_DATA_FETCHED) {
            if (acoustIdResult) {
                if (!trackInfo) {
                    trackInfo = await this._tagDatabase.getTrackInfoByTrackUid(trackUid);
                }

                try {
                    const fetchedCoverArt = await this._fetchCoverArtInfo(cancellationToken, acoustIdResult, trackInfo);
                    if (!trackInfoUpdated) {
                        trackInfoUpdated = fetchedCoverArt;
                    }
                } catch (e) {
                    await this._tagDatabase.setAcoustIdFetchJobError(jobId, e);
                    if (waitLongTime) {
                        await delay(10000);
                    }
                    return JOBS_FOUND_TOKEN;
                }
            }
            await this._tagDatabase.completeAcoustIdFetchJob(jobId);
        }

        this.postMessage({type: ACOUST_ID_DATA_RESULT_MESSAGE, result: {trackInfo, trackInfoUpdated}});
        if (waitLongTime) {
            await delay(10000);
        }
        return JOBS_FOUND_TOKEN;
    }

   async _parseMetadataJob(job, file, trackUid) {
        let trackInfo = await this._tagDatabase.getTrackInfoByTrackUid(trackUid);

        if (trackInfo) {
            return trackInfo;
        }

        const data = {
            trackUid,
            codecName: null,
            duration: 0,
            autogenerated: false
        };
        const fileView = new FileView(file);
        const codecName = await getCodecName(fileView);
        if (!codecName) {
            throw codecNotSupportedError();
        }

        switch (codecName) {
            case `wav`:
            case `webm`:
            case `aac`:
            case `ogg`:
                throw codecNotSupportedError();
            case `mp3`:
                await parseMp3Metadata(data, fileView);
                break;
            default: break;
        }
        data.codecName = codecName;
        data.duration = data.demuxData.duration;
        data.trackUid = trackUid;

        if (!data.artist || !data.title) {
            const {artist, title} = trackInfoFromFileName(file.name);
            data.artist = artist;
            data.title = title;
            data.autogenerated = true;
        }

        if (data.pictures) {
            const {pictures} = data;
            delete data.pictures;
            await this._tagDatabase.addAlbumArtData(trackUid, {
                trackUid,
                images: pictures.map(i => Object.assign({[IMAGE_TYPE_KEY]: IMAGE_TYPE_BLOB}, i)),
                album: data.album || null,
                artist: data.artist
            });
        }

        trackInfo = buildTrackInfo(data, data.demuxData);
        await this._tagDatabase.replaceTrackInfo(trackUid, trackInfo);
        return trackInfo;
    }

    async _fetchAcoustId(cancellationToken, uid, fingerprint, duration) {
        const data = queryString({
            client: `djbbrJFK`,
            format: `json`,
            duration: duration | 0,
            meta: `recordings+releasegroups+compress`,
            fingerprint
        });
        const url = `https://api.acoustId.org/v2/lookup?${data}`;

        let result;
        const fullResponse = await ajaxGet(toCorsUrl(url), cancellationToken);
        if (fullResponse.results && fullResponse.results.length > 0) {
            result = parseAcoustId(fullResponse);
        }
        const trackInfo = await this._tagDatabase.getTrackInfoByTrackUid(uid);
        const wasAutogenerated = trackInfo.autogenerated;

        let trackInfoUpdated = false;
        if (result) {
            trackInfo.autogenerated = false;
            const {album: albumResult,
                   title: titleResult,
                   artist: artistResult,
                   albumArtist: albumArtistResult} = result;
            const {name: album} = albumResult || {};
            const {name: title} = titleResult || {};
            const {name: artist} = artistResult || {};
            const {name: albumArtist} = albumArtistResult || {};

            if ((isUnknown(trackInfo.title) || wasAutogenerated) && title) {
                trackInfo.title = title;
                trackInfoUpdated = true;
            }

            if ((isUnknown(trackInfo.album) || wasAutogenerated) && album) {
                trackInfo.album = album;
                trackInfoUpdated = true;
            }

            if ((isUnknown(trackInfo.albumArtist) || wasAutogenerated) && albumArtist) {
                trackInfo.albumArtist = albumArtist;
                trackInfoUpdated = true;
            }

            if ((isUnknown(trackInfo.artist) || wasAutogenerated) && artist) {
                trackInfo.artist = artist;
                trackInfoUpdated = true;
            }
        }

        trackInfo.acoustIdFullResponse = fullResponse;
        await this._tagDatabase.replaceTrackInfo(uid, trackInfo);
        return {
            acoustIdResult: result || null,
            trackInfo,
            trackInfoUpdated
        };
    }

    async _fetchCoverArtInfo(cancellationToken, acoustIdResult, trackInfo) {
        const {trackUid} = trackInfo;
        const {album, title} = acoustIdResult;
        let mbid, type;

        if (album && album.mbid) {
            ({mbid, type} = album);
        } else if (title && title.mbid) {
            ({mbid, type} = title);
        } else {
            return false;
        }

        const {artist: taggedArtist,
                album: taggedAlbum} = trackInfo;
        try {
            const response = await ajaxGet(toCorsUrl(`https://coverartarchive.org/${type}/${mbid}`), cancellationToken);
            if (response && response.images && response.images.length > 0) {
                await this._tagDatabase.addAlbumArtData(trackUid, {
                    trackUid,
                    images: response.images.map(i => Object.assign({[IMAGE_TYPE_KEY]: IMAGE_TYPE_COVERARTARCHIVE}, i)),
                    artist: taggedArtist,
                    album: taggedAlbum
                });
                return true;
            }
        } catch (e) {
            if (e.status !== 404) {
                throw e;
            }
        }
        return false;
    }

    async _maybeDownloadCoverArt(url) {
        if (this._coverArtDownloader.jobsActive >= this._coverArtDownloader.parallelJobs) {
            await this._coverArtDownloader.cancelOldestJob();
        }
        try {
            const result = await this._coverArtDownloader.postJob(url).promise;
            return result;
        } catch (e) {
            return null;
        }
    }

    async _getAlbumArt(trackUid, artist, album, preference = ALBUM_ART_PREFERENCE_SMALLEST) {
        let result = null;

        const albumArtData = await this._tagDatabase.getAlbumArtData(trackUid, artist, album);

        if (!albumArtData) {
            result = preference === ALBUM_ART_PREFERENCE_ALL ? [] : null;
        } else {
            const images = albumArtData.images || [];

            if (preference !== ALBUM_ART_PREFERENCE_ALL) {
                if (images.length > 0) {
                    images.sort((a, b) => {
                        const cmp = getDescriptionWeight(a) - getDescriptionWeight(b);
                        if (cmp !== 0) {
                            return cmp;
                        }
                        const aTypeWeight = imageTypeKeyWeights[a[IMAGE_TYPE_KEY]];
                        const bTypeWeight = imageTypeKeyWeights[b[IMAGE_TYPE_KEY]];
                        return aTypeWeight - bTypeWeight;
                    });

                    const image = images[0];

                    if (image[IMAGE_TYPE_KEY] === IMAGE_TYPE_BLOB) {
                        result = image.image;
                    } else if (preference === ALBUM_ART_PREFERENCE_SMALLEST) {
                        result = image.thumbnails.small;
                    } else {
                        result = image.image;
                    }

                    let blobResult;
                    if (typeof result === `string`) {
                        blobResult = await this._maybeDownloadCoverArt(result);
                    }

                    if (blobResult) {
                        result = blobResult;
                        await this._tagDatabase.addAlbumArtData(trackUid, {
                            trackUid,
                            images: [{
                                [IMAGE_TYPE_KEY]: IMAGE_TYPE_BLOB,
                                image: blobResult,
                                description: `${Array.isArray(image.types) ? image.types.join(`, `) : `none`}`
                            }],
                            album,
                            artist
                        });
                    }
                }
            } else {
                result = images.map(_.image);
            }
        }

        if (!result) {
            return result;
        } else if (Array.isArray(result)) {
            return result.map(this._mapToUrl, this);
        } else {
            return this._mapToUrl(result);
        }
    }

    _checkBlobList() {
        if (this._blobUrlSize > MAX_BLOB_URL_SIZE) {
            const target = MAX_BLOB_URL_SIZE / 2 | 0;
            let blobUrlSize = this._blobUrlSize;
            while (blobUrlSize > target) {
                const {url, size} = this._blobUrls.shift();
                blobUrlSize -= size;
                try {
                    URL.revokeObjectURL(url);
                } catch (e) {
                    // NOOP
                }
            }
            this._blobUrlSize = blobUrlSize;
        }
    }

    _mapToUrl(value) {
        if (typeof value === `string`) {
            return value.replace(/^https?:\/\//i, `https://`);
        } else if (value instanceof Blob) {
            const url = URL.createObjectURL(value);
            const {size} = value;
            this._blobUrls.push({url, size});
            this._blobUrlSize += size;
            this._checkBlobList();
            return url;
        } else {
            throw new Error(`unknown value ${value} ${typeof value}`);
        }
    }

}
