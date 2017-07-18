import {toTimeString, ownPropOr} from "util";
import {URL, Image} from "platform/platform";

const INITIAL = 1;
const NO_IMAGE_FOUND = 2;
const PENDING_IMAGE = 3;
const HAS_IMAGE = 4;
const albumNameToCoverArtUrlMap = Object.create(null);

const NULL_STRING = `\x00`;

const clearPicture = function(picture) {
    if (picture.blobUrl) {
        URL.revokeObjectURL(picture.blobUrl);
    }

    if (picture.blob) {
        picture.blob.close();
    }

    picture.blobUrl = picture.blob = picture.image = null;
}

const tagDatasHoldingPictures = [];

const addPictureHoldingTagData = function(tagData) {
    tagDatasHoldingPictures.push(tagData);

    if (tagDatasHoldingPictures.length > 50) {
        while (tagDatasHoldingPictures.length > 25) {
            tagDatasHoldingPictures.shift().reclaimPictures();
        }
    }
}

const removePictureHoldingTagData = function(tagData) {
    const i = tagDatasHoldingPictures.indexOf(tagData);
    if (i >= 0) {
        tagDatasHoldingPictures.splice(i, 1);
    }
}

class TagData {
    constructor(track, data, context) {
        this.track = track;

        this.title = data.title;
        this.artist = data.artist;
        this.album = data.album;
        this.albumArtist = data.albumArtist;
        this.autogenerated = data.autogenerated;

        const {duration, sampleRate, channels} = data.demuxData;
        this.duration = duration;
        this.sampleRate = sampleRate;
        this.channels = channels;

        this.year = ownPropOr(data, `year`, null);
        this.genres = ownPropOr(data, `genres`, []);

        this.discNumber = ownPropOr(data, `discNumber`, 0);
        this.discCount = ownPropOr(data, `discCount`, 1);
        this.albumIndex = ownPropOr(data, `albumIndex`, 0);
        this.trackCount = ownPropOr(data, `trackCount`, 1);

        this.acoustIdCoverArt = null;
        this.rating = -1;
        this.skipCounter = 0;
        this.playthroughCounter = 0;
        this.lastPlayed = 0;
        this.pictures = ownPropOr(data, `pictures`, []);

        this._formattedTime = null;
        this._coverArtImageState = INITIAL;

        this._hasBeenAnalyzed = false;

        this._context = context;
        this._stateId = INITIAL;
    }

    hasSufficientMetadata() {
        return this.autogenerated === false &&
                this.artist !== null &&
                this.title !== null &&
                this.pictures.length > 0;
    }

    getStateId() {
        return this._stateId;
    }

    formatTime() {
        if (this._formattedTime !== null) return this._formattedTime;
        if (!this.duration) {
            this._formattedTime = ``;
            return ``;
        }
        const duration = Math.max(0, this.duration);
        return (this._formattedTime = toTimeString(duration));
    }

    getAlbum() {
        return this.album;
    }

    getTitle() {
        return this.title;
    }

    getArtist() {
        return this.artist;
    }

    isRated() {
        return this.rating !== -1;
    }

    getRating() {
        return this.rating;
    }

    setRating(val) {
        this.rating = Math.min(5, Math.max(1, +val));
        this._context.usageData.rateTrack(this.track, this.rating);
    }

    unsetRating() {
        this.rating = -1;
        this._context.usageData.rateTrack(this.track, this.rating);
    }

    albumNameKey() {
        return (`${this.album} ${this.albumArtist}`).toLowerCase();
    }

    maybeCoverArtImage() {
        if (!this.album) return null;
        const mapped = albumNameToCoverArtUrlMap[this.albumNameKey()];
        if (mapped) {
            const ret = new Image();
            ret.src = mapped;
            ret.tag = this.albumNameKey();
            ret.promise = new Promise((resolve, reject) => {
                ret.addEventListener(`load`, resolve, false);
                ret.addEventListener(`error`, () => {
                    albumNameToCoverArtUrlMap[ret.tag] = null;
                    reject(new Error(`invalid image`));
                }, false);
            });
            return ret;
        }
        return null;
    }

    reclaimPictures() {
        for (let i = 0; i < this.pictures.length; ++i) {
            const picture = this.pictures[i];
            if (picture.blobUrl) {
                URL.revokeObjectURL(picture.blobUrl);
            }
            picture.blobUrl = picture.image = null;
        }
    }

    _getEmbeddedImage() {
        let clear, error;
        const picture = this.pictures[0];
        if (picture.image) {
            return picture.image;
        }

        addPictureHoldingTagData(this);
        const img = new Image();
        picture.image = img;
        img.tag = picture.tag;
        let blobUrl;

        clear = () => {
            img.removeEventListener(`load`, clear, false);
            img.removeEventListener(`error`, error, false);
            if (!clear) {
                return;
            }
            clear = error = picture.blobUrl = null;
            URL.revokeObjectURL(blobUrl);

        };

        error = () => {
            clear();
            const i = this.pictures.indexOf(picture);
            if (i >= 0) {
                this.pictures.splice(i, 1);
            }
            clearPicture(picture);
        };

        img.addEventListener(`load`, clear, false);
        img.addEventListener(`error`, error, false);

        if (picture.blobUrl) {
            img.src = picture.blobUrl;
            img.blob = picture.blob;
            blobUrl = img.src;
            if (img.complete) {
                clear();
            }
            return img;
        }

        const url = URL.createObjectURL(picture.blob);
        picture.blobUrl = url;
        img.src = url;
        img.blob = picture.blob;
        if (img.complete) {
            clear();
        }
        return img;
    }

    getImage() {
        if (this.pictures.length) {
            return this._getEmbeddedImage();
        }
        return this.maybeCoverArtImage();
    }

    destroy() {
        this._context.search.removeFromSearchIndex(this.track);
        while (this.pictures.length) {
            clearPicture(this.pictures.shift());
        }
        removePictureHoldingTagData(this);
    }

    getTitleForSort() {
        return this.title;
    }

    getAlbumArtistForSort() {
        if (this.albumArtist === null) return NULL_STRING;
        return this.albumArtist;
    }

    getAlbumForSort() {
        return this.albumNameKey();
    }

    getArtistForSort() {
        return this.artist;
    }

    getDiscNumberForSort() {
        return this.discNumber;
    }

    getAlbumIndexForSort() {
        return this.albumIndex;
    }

    hasAcoustIdImage() {
        return albumNameToCoverArtUrlMap[this.albumNameKey()] ||
                typeof this._coverArtImageState === HAS_IMAGE;
    }

    fetchAcoustIdImageStarted() {
        this._coverArtImageState = PENDING_IMAGE;
    }

    fetchAcoustIdImageEnded(image, error) {
        if (error || !image) {
            this._coverArtImageState = NO_IMAGE_FOUND;
        } else {
            this._coverArtImageState = HAS_IMAGE;
            albumNameToCoverArtUrlMap[this.albumNameKey()] = image.url;
            this.track.tagDataUpdated();
        }
    }

    shouldRetrieveAcoustIdImage() {
        return this.acoustIdCoverArt &&
               !this.pictures.length &&
               this._coverArtImageState === INITIAL &&
               !albumNameToCoverArtUrlMap[this.albumNameKey()];
    }

    setAcoustIdCoverArt(acoustIdCoverArt) {
        if (acoustIdCoverArt) {
            this.acoustIdCoverArt = acoustIdCoverArt;
        }
    }

    hasBeenAnalyzed() {
        return this._hasBeenAnalyzed;
    }

    recordSkip() {
        this.skipCounter++;
        this.lastPlayed = Date.now();
        this._context.usageData.setSkipCounter(this.track, this.skipCounter);
    }

    triggerPlaythrough() {
        this.playthroughCounter++;
        this.lastPlayed = Date.now();
        this._context.usageData.setPlaythroughCounter(this.track, this.playthroughCounter);
    }

    setDataFromTagDatabase(data) {
        this._hasBeenAnalyzed = true;

        this.title = ownPropOr(data, `title`, this.title);
        this.artist = ownPropOr(data, `artist`, this.artist);
        this.album = ownPropOr(data, `album`, this.album);
        this.albumArtist = ownPropOr(data, `albumArtist`, this.albumArtist);
        this.acoustIdCoverArt = ownPropOr(data, `acoustIdCoverArt`, this.acoustIdCoverArt);
        this.autogenerated = ownPropOr(data, `autogenerated`, this.autogenerated);
        this.skipCounter = ownPropOr(data, `skipCounter`, this.skipCounter);
        this.playthroughCounter = ownPropOr(data, `playthroughCounter`, this.playthroughCounter);
        this.lastPlayed = ownPropOr(data, `lastPlayed`, this.lastPlayed);
        this.duration = ownPropOr(data, `duration`, this.duration);
        this.rating = ownPropOr(data, `rating`, this.rating);

        this._formattedTime = null;

        this.track.tagDataUpdated();
    }
}

export default class TagDataContext {
    constructor() {
        this.usageData = null;
        this.search = null;
    }

    setDeps(deps) {
        this.usageData = deps.usageData;
        this.search = deps.search;

    }
    create(track, data) {
        return new TagData(track, data, this);
    }
}
