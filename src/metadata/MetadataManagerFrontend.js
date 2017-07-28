import {METADATA_MANAGER_READY_EVENT_NAME,
            ALBUM_ART_RESULT_MESSAGE,
            ACOUST_ID_DATA_RESULT_MESSAGE,
            METADATA_RESULT_MESSAGE,
            TRACKINFO_BATCH_RESULT_MESSAGE,
            ALL_FILES_PERSISTED_MESSAGE,
            MEDIA_LIBRARY_SIZE_COUNTED_MESSAGE,
            UIDS_MAPPED_TO_FILES_MESSAGE,
            NEW_TRACK_FROM_TMP_FILE_MESSAGE,
            FILE_REFERENCE_UNAVAILABLE_MESSAGE,
            QUOTA_EXCEEDED_MESSAGE,
        fileReferenceToTrackUid} from "metadata/MetadataManagerBackend";
import EventEmitter from "events";
import {indexedDB} from "platform/platform";
import {hexString, toTimeString, ownPropOr, delay} from "util";
import WorkerFrontend from "WorkerFrontend";
import {AUDIO_FILE_EXTRACTED_EVENT} from "zip/ZipperFrontend";
import QuotaExceededEmitterTrait from "platform/QuotaExceededEmitterTrait";
import DatabaseClosedEmitterTrait from "platform/DatabaseClosedEmitterTrait";
import {DATABASE_HAS_BEEN_CLOSED_MESSAGE} from "DatabaseUsingBackend";

const NULL_STRING = `\x00`;
const ONE_HOUR_MS = 60 * 60 * 1000;
const QUARTER_HOUR_MS = 15 * 60 * 1000;
const tracksWithWeightDeadline = new Set();
const DEFAULT_ARTIST = `Unknown Artist`;
const DEFAULT_TITLE = `Unknown Title`;
const DEFAULT_ALBUM = `Unknown Album`;

export function timerTick(now) {
    for (const track of tracksWithWeightDeadline) {
        if (now > track._weightDeadline) {
            track._weightChanged();
        }
    }
}

export const VIEW_UPDATE_EVENT = `viewUpdate`;
export const TAG_DATA_UPDATE_EVENT = `tagDataUpdate`;
export const ALL_FILES_PERSISTED_EVENT = `allFilesPersisted`;
export const MEDIA_LIBRARY_SIZE_CHANGE_EVENT = `mediaLibrarySizeChange`;
export const NEW_TRACK_FROM_TMP_FILE_EVENT = `newTrackFromTmpFile`;
export const TRACK_BACKING_FILE_REMOVED_EVENT = `TRACK_BACKING_FILE_REMOVED_EVENT`;

class Track extends EventEmitter {
    constructor(fileReference, uid, metadataManager) {
        super();
        this._uid = uid;
        this._fileReference = fileReference;
        this._error = null;
        this._isPlaying = false;
        this._offline = true;
        this._weight = 3;
        this._weightDeadline = -1;
        this._metadataManager = metadataManager;
        this._title = DEFAULT_TITLE;
        this._artist = DEFAULT_ARTIST;
        this._album = DEFAULT_ALBUM;
        this._albumArtist = this._artist;
        this._autogenerated = false;
        this._duration = 0;
        this._sampleRate = 44100;
        this._channels = 2;
        this._year = null;
        this._genres = null;
        this._albumIndex = 0;
        this._trackCount = 1;
        this._rating = -1;
        this._skipCounter = 0;
        this._playthroughCounter = 0;
        this._lastPlayed = new Date(0);
        this._albumForSort = null;
        this._discNumber = 0;
        this._discCount = 1;

        this._formattedName = null;
        this._formattedFullName = null;
        this._formattedTime = null;
    }

    updateFields(trackInfo) {
        this._title = trackInfo.title;
        this._artist = trackInfo.artist;
        this._album = trackInfo.album;
        this._albumArtist = trackInfo.albumArtist;
        this._autogenerated = trackInfo.autogenerated;
        this._duration = trackInfo.duration;
        this._sampleRate = trackInfo.sampleRate;
        this._channels = trackInfo.channels;
        this._year = trackInfo.year;
        this._genres = trackInfo.genres;
        this._albumIndex = trackInfo.albumIndex;
        this._trackCount = trackInfo.trackCount;
        this._rating = trackInfo.rating;
        this._skipCounter = trackInfo.skipCounter;
        this._playthroughCounter = trackInfo.playthroughCounter;
        this._lastPlayed = trackInfo.lastPlayed;
        this._albumForSort = `${this._album} ${this._albumArtist}`.toLowerCase();

        this._discNumber = ownPropOr(trackInfo, `discNumber`, this._discNumber);
        this._discCount = ownPropOr(trackInfo, `discCount`, this._discCount);

        this._formattedName = null;
        this._formattedFullName = null;
        this._formattedTime = null;
        this.tagDataUpdated();
    }

    get fileReference() {
        return this._fileReference;
    }

    get sampleRate() {
        return this._sampleRate;
    }

    get duration() {
        return this._duration;
    }

    get artist() {
        return this._artist || DEFAULT_ARTIST;
    }

    get title() {
        return this._title || DEFAULT_TITLE;
    }

    get album() {
        return this._album || DEFAULT_ALBUM;
    }

    isAvailableOffline() {
        return this._offline;
    }

    stopPlaying() {
        this._isPlaying = false;
        this.emit(VIEW_UPDATE_EVENT, `viewUpdatePlayingStatusChange`);
    }

    startPlaying() {
        this._isPlaying = true;
        this.emit(VIEW_UPDATE_EVENT, `viewUpdatePlayingStatusChange`);
    }

    isPlaying() {
        return this._isPlaying;
    }

    unsetError() {
        this._error = null;
        this.emit(VIEW_UPDATE_EVENT, `viewUpdateErrorStatusChange`);
        this._weightChanged();
    }

    setError(message) {
        this._error = message;
        this.emit(VIEW_UPDATE_EVENT, `viewUpdateErrorStatusChange`);
        this._weightChanged();
    }

    hasError() {
        return !!this._error;
    }

    getFileReference() {
        return this._fileReference;
    }

    getSampleRate() {
        return this._sampleRate;
    }

    formatFullName() {
        if (this._formattedFullName) {
            return this._formattedFullName;
        }
        let name = this.formatName();
        if (this._album) {
            const {_albumIndex: albumIndex, _trackCount: trackCount} = this;
            let position = ``;
            if (albumIndex !== -1 && trackCount === -1) {
                position = ` #${albumIndex}`;
            } else if (albumIndex !== -1 && trackCount !== -1) {
                position = ` #${albumIndex}/${trackCount}`;
            }
            name = `${name} [${this._album}${position}]`;
        }
        this._formattedFullName = name;
        return name;
    }

    formatName() {
        if (this._formattedName) {
            return this._formattedName;
        }
        const {_artist, _title} = this;
        const ret = `${_artist} - ${_title}`;
        this._formattedName = ret;
        return ret;
    }

    formatTime() {
        if (this._formattedTime !== null) {
            return this._formattedTime;
        }

        let result;

        if (this._duration === 0) {
            result = ``;
        } else {
            result = toTimeString(this._duration);
        }
        this._formattedTime = result;
        return result;
    }

    getDuration() {
        return this._duration;
    }

    tagDataUpdated() {
        this.emit(TAG_DATA_UPDATE_EVENT, this);
        this.emit(VIEW_UPDATE_EVENT, `viewUpdateTagDataChange`);
        this._weightChanged();
    }

    uidEquals(uid) {
        return indexedDB.cmp(this.uid(), uid) === 0;
    }

    uid() {
        return this._uid;
    }

    comesBeforeInSameAlbum(otherTrack) {
        return this.isFromSameAlbumAs(otherTrack) && this._albumIndex === otherTrack._albumIndex - 1;
    }

    comesAfterInSameAlbum(otherTrack) {
        return this.isFromSameAlbumAs(otherTrack) && this._albumIndex === otherTrack._albumIndex + 1;
    }

    isFromSameAlbumAs(otherTrack) {
        if (!otherTrack) return false;
        if (otherTrack === this) return true;
        if (!otherTrack._album || !this._album) return false;

        return this._album === otherTrack._album &&
               this._albumArtist === otherTrack._albumArtist;
    }

    rate(value) {
        if (value === -1) {
            this._rating = -1;
            this._metadataManager._unrate(this);
        } else {
            value = Math.max(1, Math.min(+value, 5));
            this._rating = value;
            this._metadataManager._rate(this, value);
        }
    }

    getRating() {
        return this._rating;
    }

    isRated() {
        return this._rating !== -1;
    }

    getSkipCount() {
        return this._skipCounter;
    }

    recordSkip() {
        this._skipCounter++;
        this._lastPlayed = new Date();
        this._metadataManager._recordSkip(this);
        this._weightChanged();
    }

    triggerPlaythrough() {
        if (this.hasError()) {
            this.unsetError();
        }
        this._playthroughCounter++;
        this._lastPlayed = new Date();
        this._metadataManager._recordPlaythrough(this);
        this._weightChanged();
    }

    getPlaythroughCount() {
        return this._playthroughCounter;
    }

    getLastPlayed() {
        return this._lastPlayed;
    }

    hasBeenPlayedWithin(time) {
        return +this.getLastPlayed() >= +time;
    }

    _weightChanged() {
        if (this.hasError()) {
            this._weight = 0;
        } else {
            const rating = this.isRated() ? this.getRating() : 3;
            let weight = Math.pow(1.5, rating - 1) * 3;
            const now = Date.now();

            if (this.hasBeenPlayedWithin(now - QUARTER_HOUR_MS)) {
                weight = 0;
                this._weightDeadline = this.getLastPlayed() + QUARTER_HOUR_MS;
                tracksWithWeightDeadline.add(this);
            } else if (this.hasBeenPlayedWithin(now - ONE_HOUR_MS)) {
                weight /= 9;
                this._weightDeadline = this.getLastPlayed() + ONE_HOUR_MS;
                tracksWithWeightDeadline.add(this);
            } else {
                this._weightDeadline = -1;
                tracksWithWeightDeadline.delete(this);
            }
            this._weight = Math.ceil(weight);
        }
    }

    getWeight(currentTrack, nextTrack) {
        if (this === currentTrack || this === nextTrack) {
            return 0;
        }

        return this._weight;
    }

    getTitleForSort() {
        return this._title;
    }

    getAlbumArtistForSort() {
        if (this._albumArtist === null) return NULL_STRING;
        return this._albumArtist;
    }

    getAlbumForSort() {
        return this._albumForSort;
    }

    getArtistForSort() {
        return this._artist;
    }

    getDiscNumberForSort() {
        return this._discNumber;
    }

    getAlbumIndexForSort() {
        return this._albumIndex;
    }
}

export default class MetadataManagerFrontend extends WorkerFrontend {
    constructor(deps) {
        super(METADATA_MANAGER_READY_EVENT_NAME, deps.workerWrapper);
        this._permissionPrompt = deps.permissionPrompt;
        this._env = deps.env;
        this._page = deps.page;
        this._zipper = deps.zipper;

        this._allFilesPersisted = true;
        this._persistentPermissionAsked = false;
        this._mediaLibrarySize = 0;
        this._uidsToTrack = new Map();
        this._messagesToMethods = {
            [ALBUM_ART_RESULT_MESSAGE]: this._albumArtResultReceived.bind(this),
            [ACOUST_ID_DATA_RESULT_MESSAGE]: this._acoustIdDataFetched.bind(this),
            [METADATA_RESULT_MESSAGE]: this._trackMetadataParsed.bind(this),
            [TRACKINFO_BATCH_RESULT_MESSAGE]: this._trackInfoBatchRetrieved.bind(this),
            [ALL_FILES_PERSISTED_MESSAGE]: this._allFilesHaveBeenPersisted.bind(this),
            [MEDIA_LIBRARY_SIZE_COUNTED_MESSAGE]: this._mediaLibrarySizeCounted.bind(this),
            [UIDS_MAPPED_TO_FILES_MESSAGE]: this._uidsMappedToFiles.bind(this),
            [NEW_TRACK_FROM_TMP_FILE_MESSAGE]: this._newTrackFromTmpFile.bind(this),
            [FILE_REFERENCE_UNAVAILABLE_MESSAGE]: this._fileReferenceUnavailable.bind(this),
            [QUOTA_EXCEEDED_MESSAGE]: this.quotaExceeded.bind(this),
            [DATABASE_HAS_BEEN_CLOSED_MESSAGE]: this.databaseClosed.bind(this)
        };

        this._zipper.on(AUDIO_FILE_EXTRACTED_EVENT, this._audioFileExtracted.bind(this));
    }

    _fileReferenceUnavailable(result) {
        const {trackUid} = result;
        const key = hexString(trackUid);
        const track = this._uidsToTrack.get(key);
        if (track) {
            track.setError(`backing file has been deleted`);
            this.emit(TRACK_BACKING_FILE_REMOVED_EVENT, track);
            this._uidsToTrack.delete(key);
        }
    }

    _uidsMappedToFiles(result) {
        this._zipper.archiveFiles(result.files);
    }

    _exportTracks(tracks) {
        const trackUids = tracks.map(track => track.uid());
        this.postMessage({action: `mapTrackUidsToFiles`, args: {trackUids}});
    }

    _newTrackFromTmpFile(result) {
        const {trackInfo} = result;
        const {trackUid} = trackInfo;
        const key = hexString(trackUid);

        let track = this._uidsToTrack.get(key);
        if (!track) {
            track = new Track(trackUid, trackUid, this);
            this._uidsToTrack.set(key, track);
            track.updateFields(trackInfo);
        }
        this.emit(NEW_TRACK_FROM_TMP_FILE_EVENT, track);
    }

    receiveMessage(event) {
        if (!event.data) return;
        const {result, type} = event.data;
        this._messagesToMethods[type](result);
    }


    getAlbumArt(track, {artist, album, preference, requestReason}) {
        const trackUid = track.uid();
        this.postMessage({
            action: `getAlbumArt`,
            args: {trackUid, artist, album, preference, requestReason}
        });
    }

    async mapTrackUidsToTracks(trackUids) {
        await this.ready();
        const tracks = new Array(trackUids.length);
        const trackUidsNeedingTrackInfo = [];

        for (let i = 0; i < tracks.length; ++i) {
            const trackUid = trackUids[i];
            const key = hexString(trackUid);
            const cached = this._uidsToTrack.get(key);
            if (cached) {
                tracks[i] = cached;
            } else {
                const track = new Track(trackUid, trackUid, this);
                tracks[i] = track;
                this._uidsToTrack.set(key, track);
                trackUidsNeedingTrackInfo.push(trackUid);
            }
        }

        this._fetchTrackInfoForTracks(trackUidsNeedingTrackInfo);
        return tracks;
    }

    getTrackByTrackUid(trackUid) {
        return this._uidsToTrack.get(hexString(trackUid));
    }

    areAllFilesPersisted() {
        return this._allFilesPersisted;
    }

    async getTrackByFileReferenceAsync(fileReference) {
        if (!this._persistentPermissionAsked) {
            this._persistentPermissionAsked = true;
            this._persistStorage();
        }

        const trackUid = await fileReferenceToTrackUid(fileReference);
        const key = hexString(trackUid);
        const cached = this._uidsToTrack.get(key);
        if (cached) {
            return cached;
        }
        this._allFilesPersisted = false;
        const track = new Track(fileReference, trackUid, this);
        this._parseMetadata(fileReference);
        this._uidsToTrack.set(key, track);
        return track;
    }

    getMediaLibrarySize() {
        return this._mediaLibrarySize;
    }

    _mediaLibrarySizeCounted(count) {
        this._mediaLibrarySize = count;
        this.emit(MEDIA_LIBRARY_SIZE_CHANGE_EVENT, count);
    }

    _albumArtResultReceived(albumArtResult) {
        const {trackUid, albumArt, requestReason} = albumArtResult;
        if (albumArt) {
            const track = this.getTrackByTrackUid(trackUid);
            if (track) {
                this.emit(`albumArt`, track, albumArt, requestReason);
            }
        }
    }

    _acoustIdDataFetched(acoustIdResult) {
        const {trackInfo, trackInfoUpdated} = acoustIdResult;
        const {trackUid} = trackInfo;
        const track = this.getTrackByTrackUid(trackUid);

        if (trackInfoUpdated && track) {
            track.updateFields(trackInfo);
        }
    }

    _trackInfoBatchRetrieved(trackInfoBatchResult) {
        const {trackInfos} = trackInfoBatchResult;
        for (let i = 0; i < trackInfos.length; ++i) {
            const trackInfo = trackInfos[i];
            const track = this._uidsToTrack.get(hexString(trackInfo.trackUid));
            track.updateFields(trackInfo);
        }
    }

    _trackMetadataParsed(metadataResult) {
        const {trackInfo, trackUid, error} = metadataResult;
        const track = this.getTrackByTrackUid(trackUid);

        if (track) {
            if (error) {
                track.setError(error && error.message || `${error}`);
            } else {
                track.updateFields(trackInfo);
            }
        }
    }

    _parseMetadata(fileReference) {
        this.postMessage({action: `parseMetadata`, args: {fileReference}});
    }

    _allFilesHaveBeenPersisted() {
        this._allFilesPersisted = true;
        this.emit(ALL_FILES_PERSISTED_EVENT);
    }

    _rate(track, rating) {
        this.postMessage({action: `setRating`, args: {trackUid: track.uid(), rating}});
    }

    _unrate(track) {
        this.postMessage({action: `setRating`, args: {trackUid: track.uid(), rating: -1}});
    }

    _recordSkip(track) {
        this.postMessage({action: `setSkipCounter`, args: {trackUid: track.uid(), counter: track._skipCounter, lastPlayed: track._lastPlayed}});
    }

    _recordPlaythrough(track) {
        this.postMessage({action: `setPlaythroughCounter`, args: {trackUid: track.uid(), counter: track._playthroughCounter, lastPlayed: track._lastPlayed}});
    }

    _audioFileExtracted(tmpFileId) {
        this.postMessage({action: `parseTmpFile`, args: {tmpFileId}});
    }

    async _persistStorage() {
        const {storage} = this._page.navigator();
        if (storage && storage.persist && storage.persisted) {
            const isStoragePersisted = await storage.persisted();
            if (!isStoragePersisted) {
                await this._permissionPrompt.prompt(storage.persist.bind(storage));
            }
        }
    }

    async _fetchTrackInfoForTracks(trackUidsNeedingTrackInfo) {
        const BATCH_SIZE = 250;
        let i = 0;

        do {
            await delay(16);
            const batch = trackUidsNeedingTrackInfo.slice(i, i + BATCH_SIZE);
            i += BATCH_SIZE;
            this.postMessage({action: `getTrackInfoBatch`, args: {batch}});
        } while (i < trackUidsNeedingTrackInfo.length);
    }
}

Object.assign(MetadataManagerFrontend.prototype, QuotaExceededEmitterTrait, DatabaseClosedEmitterTrait);
