import {iDbPromisifyCursor, iDbPromisify, applyStoreSpec, getIndexedDbStorageInfo} from "utils/indexedDbUtil";
import {indexedDB, DatabaseClosedError, IDBKeyRange, ArrayBuffer, File, CONSTRAINT_ERROR,
    QUOTA_EXCEEDED_ERROR} from "platform/platform";
import FileSystemWrapper from "platform/FileSystemWrapper";

const VERSION = 28;
const DATA_WIPE_VERSION = 24;
const NAME = `TagDatabase`;
const TRACK_INFO_PRIMARY_KEY_NAME = `trackUid`;
const TRACK_INFO_OBJECT_STORE_NAME = `trackInfo`;

const ACOUST_ID_JOB_OBJECT_STORE_NAME = `acoustIdJobs`;
const ACOUST_ID_JOB_PRIMARY_KEY_NAME = `jobId`;

const ALBUM_ART_OBJECT_STORE_NAME = `albumArt`;

const TRACK_PAYLOAD_OBJECT_STORE_NAME = `trackPayload`;

const TRACK_SEARCH_INDEX_OBJECT_STORE_NAME = `trackSearchIndex2`;

const PAYLOAD_TYPE_FILESYSTEM_FILE = `fileSystemFile`;
const PAYLOAD_TYPE_INDEXED_DB_FILE = `indexedDBFile`;

const LOUDNESS_ANALYZER_SERIALIZED_STATE_STORE_NAME = `loudnessInfo`;

export const trackSearchIndexCmp = function(a, b) {
    return indexedDB.cmp(a.trackUid, b.trackUid);
};

const indexedDBCmp = function(a, b) {
    return indexedDB.cmp(a, b);
};

export const stopWords = new Set([`a`, `an`, `and`, `are`, `as`, `at`, `be`, `by`,
                                  `for`, `has`, `in`, `is`, `it`, `its`, `of`, `on`, `that`, `the`,
                                  `to`, `was`, `will`, `with`]);

const READ_WRITE = `readwrite`;
const READ_ONLY = `readonly`;

const objectStoreSpec = {
    [TRACK_INFO_OBJECT_STORE_NAME]: {
        keyPath: TRACK_INFO_PRIMARY_KEY_NAME,
        indexSpec: {
            album: {
                unique: false,
                multiEntry: false,
                keyPath: `album`
            },
            albumArtist: {
                unique: false,
                multiEntry: false,
                keyPath: `albumArtist`
            },
            artist: {
                unique: false,
                multiEntry: false,
                keyPath: `artist`
            },
            genres: {
                unique: false,
                multiEntry: true,
                keyPath: `genres`
            },
            year: {
                unique: false,
                multiEntry: false,
                keyPath: `year`
            },
            lastPlayed: {
                unique: false,
                multiEntry: false,
                keyPath: `lastPlayed`
            },
            playthroughCounter: {
                unique: false,
                multiEntry: false,
                keyPath: `playthroughCounter`
            },
            rating: {
                unique: false,
                multiEntry: false,
                keyPath: `rating`
            },
            skipCounter: {
                unique: false,
                multiEntry: false,
                keyPath: `skipCounter`
            },
            title: {
                unique: false,
                multiEntry: false,
                keyPath: `title`
            }
        }
    },
    [ACOUST_ID_JOB_OBJECT_STORE_NAME]: {
        keyPath: ACOUST_ID_JOB_PRIMARY_KEY_NAME,
        autoIncrement: true,
        indexSpec: {
            [TRACK_INFO_PRIMARY_KEY_NAME]: {
                unique: true,
                multiEntry: false,
                keyPath: TRACK_INFO_PRIMARY_KEY_NAME
            },
            lastTried: {
                unique: false,
                multiEntry: false,
                keyPath: `lastTried`
            }
        }
    },
    [ALBUM_ART_OBJECT_STORE_NAME]: {
        keyPath: TRACK_INFO_PRIMARY_KEY_NAME,
        indexSpec: {
            artistAlbum: {
                unique: false,
                multiEntry: false,
                keyPath: [`album`, `artist`]
            }
        }
    },
    [TRACK_PAYLOAD_OBJECT_STORE_NAME]: {
        keyPath: TRACK_INFO_PRIMARY_KEY_NAME,
        indexSpec: {
            payloadType: {
                unique: false,
                multiEntry: false,
                keyPath: `payloadType`
            }
        }
    },
    [TRACK_SEARCH_INDEX_OBJECT_STORE_NAME]: {
        keyPath: TRACK_INFO_PRIMARY_KEY_NAME,
        indexSpec: {
            suffixMulti: {
                unique: false,
                multiEntry: true,
                keyPath: `keywordsReversed`
            },
            prefixMulti: {
                unique: false,
                multiEntry: true,
                keyPath: `keywords`
            }
        }
    },
    [LOUDNESS_ANALYZER_SERIALIZED_STATE_STORE_NAME]: {
        keyPath: TRACK_INFO_PRIMARY_KEY_NAME
    }
};


export default class TagDatabase {
    constructor() {
        this._closed = false;
        const request = indexedDB.open(NAME, VERSION);
        this.db = iDbPromisify(request);
        this.fs = new FileSystemWrapper();
        request.onupgradeneeded = (event) => {
            const {target} = event;
            const {transaction} = target;
            const stores = applyStoreSpec(transaction, objectStoreSpec);
            if (event.oldVersion < DATA_WIPE_VERSION) {
                for (const key of Object.keys(stores)) {
                    stores[key].clear();
                }
            }

        };
        this._setHandlers();
        this._usageAndQuota = null;
    }

    async _initUsageAndQuota() {
        if (this._usageAndQuota) {
            return;
        }
        this._usageAndQuota = await this._queryUsageAndQuota();
    }

    async _canProbablyStoreInFs() {
        await this._initUsageAndQuota();
        return this._usageAndQuota.fs > 0;
    }

    async _queryUsageAndQuota() {
        const db = await getIndexedDbStorageInfo();
        const fs = await this.fs.spaceAvailable();
        return {fs, db, lastRetrieved: new Date()};
    }

    async _setHandlers() {
        const db = await this.db;
        db.onversionchange = () => {
            this._closed = true;
            db.close();
        };
        db.onclose = function() {
            this._closed = true;
        };
    }

    _checkClosed() {
        if (this._closed) {
            throw new DatabaseClosedError();
        }
    }

    isClosed() {
        return this._closed;
    }

    async getTrackInfoCount() {
        this._checkClosed();
        const db = await this.db;
        const store = db.transaction(TRACK_INFO_OBJECT_STORE_NAME, READ_ONLY).objectStore(TRACK_INFO_OBJECT_STORE_NAME);
        return iDbPromisify(store.count());
    }

    async _primaryOrUniqueKeyInArrayQuery(storeName, listOfPrimaryKeys, missing) {
        this._checkClosed();
        const ret = new Array(listOfPrimaryKeys.length);
        ret.length = 0;
        listOfPrimaryKeys.sort(indexedDBCmp);
        let i = 0;
        const db = await this.db;
        const store = db.transaction(storeName, READ_ONLY).objectStore(storeName);
        const {length} = listOfPrimaryKeys;
        let completelyEmpty = true;

        if (i >= length) {
            return ret;
        }

        const query = IDBKeyRange.bound(listOfPrimaryKeys[0], listOfPrimaryKeys[length - 1]);
        await iDbPromisifyCursor(store.openCursor(query), (cursor) => {
            completelyEmpty = false;
            const {key} = cursor;
            let cmp = indexedDB.cmp(key, listOfPrimaryKeys[i]);
            while (cmp > 0) {
                if (missing) {
                    missing.push(listOfPrimaryKeys[i]);
                }
                ++i;
                if (i >= length) {
                    return true;
                }
                cmp = indexedDB.cmp(key, listOfPrimaryKeys[i]);
            }

            while (cmp === 0) {
                ret.push(cursor.value);
                i++;
                if (i >= length) {
                    return true;
                }
                cmp = indexedDB.cmp(key, listOfPrimaryKeys[i]);
            }

            cursor.continue(listOfPrimaryKeys[i]);
            return false;
        });

        if (missing && completelyEmpty) {
            missing.push(...listOfPrimaryKeys);
        }

        return ret;
    }

    async trackUidsToFiles(trackUids, missing) {
        this._checkClosed();
        const result = await this._primaryOrUniqueKeyInArrayQuery(TRACK_PAYLOAD_OBJECT_STORE_NAME, trackUids, missing);
        return result.map(obj => obj.file);
    }

    trackUidsToTrackInfos(trackUids, missing) {
        this._checkClosed();
        return this._primaryOrUniqueKeyInArrayQuery(TRACK_INFO_OBJECT_STORE_NAME, trackUids, missing);
    }

    async getTrackInfoByTrackUid(trackUid) {
        this._checkClosed();
        const db = await this.db;
        const store = db.transaction(TRACK_INFO_OBJECT_STORE_NAME, READ_ONLY).objectStore(TRACK_INFO_OBJECT_STORE_NAME);
        return iDbPromisify(store.get(trackUid));
    }

    async replaceTrackInfo(trackUid, trackInfo) {
        this._checkClosed();
        trackInfo.trackUid = trackUid;
        const db = await this.db;
        const tx = db.transaction(TRACK_INFO_OBJECT_STORE_NAME, READ_WRITE).objectStore(TRACK_INFO_OBJECT_STORE_NAME);
        return iDbPromisify(tx.put(trackInfo));
    }

    async addTrackInfo(trackUid, trackInfo) {
        this._checkClosed();
        trackInfo.trackUid = trackUid;
        const db = await this.db;
        const transaction = db.transaction(TRACK_INFO_OBJECT_STORE_NAME, READ_WRITE);
        const store = transaction.objectStore(TRACK_INFO_OBJECT_STORE_NAME);
        const previousTrackInfo = await iDbPromisify(store.get(trackUid));
        const newTrackInfo = Object.assign({}, previousTrackInfo || {}, trackInfo);
        await iDbPromisify(store.put(newTrackInfo));
        return newTrackInfo;
    }

    async completeAcoustIdFetchJob(jobId) {
        this._checkClosed();
        const db = await this.db;
        const tx = db.transaction([ACOUST_ID_JOB_OBJECT_STORE_NAME], READ_WRITE);
        const acoustIdStore = tx.objectStore(ACOUST_ID_JOB_OBJECT_STORE_NAME);
        const job = await iDbPromisify(acoustIdStore.get(IDBKeyRange.only(jobId)));
        if (!job) {
            return;
        }
        const jobDeleted = iDbPromisify(acoustIdStore.delete(IDBKeyRange.only(jobId)));
        await jobDeleted;
    }

    async setAcoustIdFetchJobError(jobId, error) {
        this._checkClosed();
        const db = await this.db;
        const tx = db.transaction(ACOUST_ID_JOB_OBJECT_STORE_NAME, READ_WRITE);
        const store = tx.objectStore(ACOUST_ID_JOB_OBJECT_STORE_NAME);
        const job = await iDbPromisify(store.get(IDBKeyRange.only(jobId)));
        job.lastTried = new Date();
        job.lastError = {
            message: error && error.message || `${error}`,
            stack: error && error.stack || null
        };
        return iDbPromisify(store.put(job));
    }

    async getAcoustIdFetchJob() {
        this._checkClosed();
        const db = await this.db;
        const tx = db.transaction(ACOUST_ID_JOB_OBJECT_STORE_NAME, READ_ONLY);
        const store = tx.objectStore(ACOUST_ID_JOB_OBJECT_STORE_NAME);
        const index = store.index(`lastTried`);
        return iDbPromisify(index.get(IDBKeyRange.lowerBound(new Date(0))));
    }

    async updateAcoustIdFetchJobState(trackUid, data) {
        this._checkClosed();
        const db = await this.db;
        const tx = db.transaction(ACOUST_ID_JOB_OBJECT_STORE_NAME, READ_WRITE);
        const store = tx.objectStore(ACOUST_ID_JOB_OBJECT_STORE_NAME);
        const uidIndex = store.index(`trackUid`);
        const job = await iDbPromisify(uidIndex.get(IDBKeyRange.only(trackUid)));

        if (!job) {
            return;
        }
        Object.assign(job, data);
        await iDbPromisify(store.put(job));
    }

    async addAcoustIdFetchJob(trackUid, fingerprint, duration, state) {
        this._checkClosed();
        const db = await this.db;
        const tx = db.transaction(ACOUST_ID_JOB_OBJECT_STORE_NAME, READ_WRITE);
        const store = tx.objectStore(ACOUST_ID_JOB_OBJECT_STORE_NAME);
        const uidIndex = store.index(`trackUid`);
        const key = await iDbPromisify(uidIndex.getKey(IDBKeyRange.only(trackUid)));

        if (key) {
            return;
        }

        await iDbPromisify(store.add({
            trackUid, created: new Date(),
            fingerprint, duration, lastError: null,
            lastTried: new Date(0), state
        }));
    }

    async getAlbumArtData(trackUid, artist, album) {
        this._checkClosed();
        const db = await this.db;
        const tx = db.transaction(ALBUM_ART_OBJECT_STORE_NAME, READ_ONLY);
        const store = tx.objectStore(ALBUM_ART_OBJECT_STORE_NAME);
        const result = await iDbPromisify(store.get(IDBKeyRange.only(trackUid)));

        if (result) {
            return result;
        }

        if (artist && album) {
            const index = store.index(`artistAlbum`);
            return iDbPromisify(index.get(IDBKeyRange.only([artist, album])));
        }
        return null;
    }

    async addAlbumArtData(trackUid, albumArtData) {
        this._checkClosed();
        const db = await this.db;
        const tx = db.transaction(ALBUM_ART_OBJECT_STORE_NAME, READ_WRITE);
        const store = tx.objectStore(ALBUM_ART_OBJECT_STORE_NAME);
        const storedData = await iDbPromisify(store.get(IDBKeyRange.only(trackUid)));

        if (storedData && storedData.images && storedData.images.length > 0) {
            const storedImages = storedData.images;
            const newImages = albumArtData.images;

            for (let i = 0; i < newImages.length; ++i) {
                const newImage = newImages[i];
                const {imageType, image} = newImage;
                let shouldBeAdded = true;
                for (let j = 0; j < storedImages.length; ++j) {
                    const storedImage = storedImages[j];
                    if (storedImage.imageType === imageType &&
                        storedImage.image === image) {
                        shouldBeAdded = false;
                        break;
                    }
                }

                if (shouldBeAdded) {
                    storedImages.push(newImage);
                }
            }
            storedData.images = storedImages;
            return iDbPromisify(store.put(storedData));
        } else {
            albumArtData.trackUid = trackUid;
            return iDbPromisify(store.put(albumArtData));
        }
    }

    async getLoudnessAnalyzerStateForTrack(trackUid) {
        this._checkClosed();
        const db = await this.db;
        const tx = db.transaction(LOUDNESS_ANALYZER_SERIALIZED_STATE_STORE_NAME, READ_ONLY);
        const store = tx.objectStore(LOUDNESS_ANALYZER_SERIALIZED_STATE_STORE_NAME);
        return iDbPromisify(store.get(trackUid));
    }

    async setLoudnessAnalyzerStateForTrack(trackUid, serializedState) {
        this._checkClosed();
        const db = await this.db;
        const tx = db.transaction(LOUDNESS_ANALYZER_SERIALIZED_STATE_STORE_NAME, READ_WRITE);
        const store = tx.objectStore(LOUDNESS_ANALYZER_SERIALIZED_STATE_STORE_NAME);
        return iDbPromisify(store.put({trackUid, serializedState}));
    }

    async fileByFileReference(fileReference) {
        this._checkClosed();
        if (fileReference instanceof File) {
            return fileReference;
        } else if (fileReference instanceof ArrayBuffer) {
            const trackUid = fileReference;
            const db = await this.db;
            const tx = db.transaction(TRACK_PAYLOAD_OBJECT_STORE_NAME, READ_ONLY);
            const store = tx.objectStore(TRACK_PAYLOAD_OBJECT_STORE_NAME);
            const result = await iDbPromisify(store.get(IDBKeyRange.only(trackUid)));

            if (!result) {
                return result;
            }

            if (result.payloadType === PAYLOAD_TYPE_FILESYSTEM_FILE) {
                if (await this._canProbablyStoreInFs()) {
                    return this.fs.getFileByTrackUid(trackUid);
                }
                return null;
            }

            return result.file ? result.file : null;
        } else {
            throw new Error(`invalid fileReference`);
        }
    }

    async ensureFileStored(trackUid, fileReference) {
        this._checkClosed();
        if (fileReference instanceof ArrayBuffer) {
            return false;
        } else if (fileReference instanceof File) {

            const db = await this.db;
            let tx = db.transaction(TRACK_PAYLOAD_OBJECT_STORE_NAME, READ_ONLY);
            let store = tx.objectStore(TRACK_PAYLOAD_OBJECT_STORE_NAME);
            const result = await iDbPromisify(store.get(trackUid));

            if (result) {
                return false;
            }

            let fsPath = null;
            let canStoreInFs = true;
            if (await this._canProbablyStoreInFs()) {
                try {
                    fsPath = await this.fs.storeFileByTrackUid(trackUid, fileReference);
                } catch (e) {
                    if (e.name !== QUOTA_EXCEEDED_ERROR) {
                        throw e;
                    }
                    canStoreInFs = false;
                }
            }

            if (canStoreInFs && !fsPath) {
                return false;
            }

            const data = canStoreInFs ? {
                payloadType: PAYLOAD_TYPE_FILESYSTEM_FILE,
                trackUid,
                originalLastModified: fileReference.lastModified,
                originalName: fileReference.name,
                originalSize: fileReference.size,
                originalType: fileReference.type,
                fileSystemPath: fsPath
            } : {
                payloadType: PAYLOAD_TYPE_INDEXED_DB_FILE,
                file: fileReference,
                trackUid
            };

            tx = db.transaction(TRACK_PAYLOAD_OBJECT_STORE_NAME, READ_WRITE);
            store = tx.objectStore(TRACK_PAYLOAD_OBJECT_STORE_NAME);

            try {
                await iDbPromisify(store.add(data));
                return true;
            } catch (e) {
                if (e.name !== CONSTRAINT_ERROR) {
                    throw e;
                }
                return false;
            }
        } else {
            throw new Error(`invalid fileReference`);
        }
    }

    async searchPrefixes(firstPrefixKeyword) {
        this._checkClosed();
        const db = await this.db;
        const tx = db.transaction(TRACK_SEARCH_INDEX_OBJECT_STORE_NAME, READ_ONLY);
        const store = tx.objectStore(TRACK_SEARCH_INDEX_OBJECT_STORE_NAME);
        const index = store.index(`prefixMulti`);
        const key = IDBKeyRange.bound(firstPrefixKeyword, `${firstPrefixKeyword}\uffff`, false, false);
        return iDbPromisify(index.getAll(key));
    }

    async searchSuffixes(firstSuffixKeyword) {
        this._checkClosed();
        const db = await this.db;
        const tx = db.transaction(TRACK_SEARCH_INDEX_OBJECT_STORE_NAME, READ_ONLY);
        const store = tx.objectStore(TRACK_SEARCH_INDEX_OBJECT_STORE_NAME);
        const index = store.index(`suffixMulti`);
        const key = IDBKeyRange.bound(firstSuffixKeyword, `${firstSuffixKeyword}\uffff`, false, false);
        return iDbPromisify(index.getAll(key));
    }

    async addSearchIndexEntryForTrackIfNotPresent(entry) {
        this._checkClosed();
        const db = await this.db;
        const tx = db.transaction(TRACK_SEARCH_INDEX_OBJECT_STORE_NAME, READ_WRITE);
        const store = tx.objectStore(TRACK_SEARCH_INDEX_OBJECT_STORE_NAME);
        const {trackUid} = entry;
        const key = IDBKeyRange.only(trackUid);

        const result = await iDbPromisify(store.getKey(key));

        if (result) {
            return;
        }

        await iDbPromisify(store.add(entry));
    }

    async updateSearchIndexEntryForTrack(entry) {
        this._checkClosed();
        const db = await this.db;
        const tx = db.transaction(TRACK_SEARCH_INDEX_OBJECT_STORE_NAME, READ_WRITE);
        const store = tx.objectStore(TRACK_SEARCH_INDEX_OBJECT_STORE_NAME);
        await iDbPromisify(store.put(entry));
    }
}

const fieldUpdater = function(...fieldNames) {
    return {
        async method(trackUid, ...values) {
            this._checkClosed();
            const db = await this.db;
            const tx = db.transaction(TRACK_INFO_OBJECT_STORE_NAME, READ_WRITE);
            const store = tx.objectStore(TRACK_INFO_OBJECT_STORE_NAME);
            let data = await iDbPromisify(store.get(trackUid));
            data = Object(data);
            data.trackUid = trackUid;
            for (let i = 0; i < fieldNames.length; ++i) {
                const name = fieldNames[i];
                const value = values[i];
                data[name] = value;
            }
            return iDbPromisify(store.put(data));
        }
    };
};

TagDatabase.prototype.updateHasInitialLoudnessInfo = fieldUpdater(`hasInitialLoudnessInfo`).method;
TagDatabase.prototype.updateHasBeenFingerprinted = fieldUpdater(`hasBeenFingerprinted`).method;
TagDatabase.prototype.updateRating = fieldUpdater(`rating`).method;
TagDatabase.prototype.updatePlaythroughCounter = fieldUpdater(`playthroughCounter`, `lastPlayed`).method;
TagDatabase.prototype.updateSkipCounter = fieldUpdater(`skipCounter`, `lastPlayed`).method;
