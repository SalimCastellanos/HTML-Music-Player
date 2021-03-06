import {PLAYBACK_STATE_CHANGE_EVENT} from "audio/frontend/AudioManager";
import {NEXT_TRACK_CHANGE_EVENT,
        CURRENT_TRACK_CHANGE_EVENT,
        TRACK_PLAYING_STATUS_CHANGE_EVENT,
        PLAYLIST_STOPPED_EVENT} from "player/PlaylistController";
import {SNACKBAR_WILL_SHOW_EVENT,
        SNACKBAR_DID_HIDE_EVENT} from "ui/Snackbar";

export const FLOATING_ACTION_BUTTON_HEIGHT = (16 + 56) / 2 | 0;

const UNKNOWN_STATE = `unknown-state`;
const PLAY_BUTTON_STATE = `play-button-state`;
const PAUSE_BUTTON_STATE = `pause-button-state`;
const ADD_BUTTON_STATE = `add-button-state`;

export default class FloatingActionButtonManager {
    constructor(opts, deps) {
        this._playerController = deps.player;
        this._playlistController = deps.playlist;
        this._recognizerContext = deps.recognizerContext;
        this._localFileHandler = deps.localFileHandler;
        this._env = deps.env;
        this._page = deps.page;
        this._snackbar = deps.snackbar;

        this._currentState = UNKNOWN_STATE;
        this._domNode = this._page.$(opts.target);

        if (this._env.hasTouch()) {
            this._stateChanged = this._stateChanged.bind(this);
            this._playerController.on(PLAYBACK_STATE_CHANGE_EVENT, this._stateChanged);
            this._playlistController.on(NEXT_TRACK_CHANGE_EVENT, this._stateChanged);
            this._playlistController.on(CURRENT_TRACK_CHANGE_EVENT, this._stateChanged);
            this._playlistController.on(TRACK_PLAYING_STATUS_CHANGE_EVENT, this._stateChanged);
            this._playlistController.on(PLAYLIST_STOPPED_EVENT, this._stateChanged);
            this._recognizerContext.createTapRecognizer(this._buttonClicked.bind(this)).recognizeBubbledOn(this.$());
            this._snackbar.on(SNACKBAR_WILL_SHOW_EVENT, this._snackbarWillShow.bind(this));
            this._snackbar.on(SNACKBAR_DID_HIDE_EVENT, this._snackbarDidHide.bind(this));

            this._awaitInitialState();
        }
    }

    $() {
        return this._domNode;
    }

    $icon() {
        return this.$().find(`.icon`);
    }

    async _awaitInitialState() {
        await Promise.all([
            this._playerController.preferencesLoaded(),
            this._playlistController.preferencesLoaded()
        ]);
        this._stateChanged();
    }

    _buttonClicked() {
        switch (this._currentState) {
        case PLAY_BUTTON_STATE:
            this._playerController.play();
            break;

        case PAUSE_BUTTON_STATE:
            this._playerController.pause();
            break;

        case ADD_BUTTON_STATE:
            this._localFileHandler.openFilePicker();
            break;
        }
    }

    _snackbarWillShow() {
        this.$().hide();
    }

    _snackbarDidHide() {
        this.$().show();
    }

    _updateButtonState() {
        const root = this.$();
        const icon = this.$icon();

        root.removeClass(`preferred-action`).show();
        icon.removeClass([`play`, `add`, `pause`]);

        switch (this._currentState) {
        case PLAY_BUTTON_STATE:
            root.addClass(`preferred-action`);
            icon.addClass(`play`);
            break;

        case PAUSE_BUTTON_STATE:
            root.addClass(`preferred-action`);
            icon.addClass(`pause`);
            break;

        case ADD_BUTTON_STATE:
            icon.addClass(`add`);
            break;
        }
    }

    _stateChanged() {
        let newState;
        if (this._playerController.canPlayPause()) {
            newState = this._playerController.isPlaying ? PAUSE_BUTTON_STATE : PLAY_BUTTON_STATE;
        } else {
            newState = ADD_BUTTON_STATE;
        }

        if (this._currentState !== newState) {
            this._currentState = newState;
            this._updateButtonState();
        }
    }
}
