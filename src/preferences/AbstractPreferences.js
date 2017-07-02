

import EventEmitter from "events";
import {inherits, throttle, noUndefinedGet} from "util";

const RESTORE_DEFAULTS_BUTTON = `restore-defaults`;
const UNDO_CHANGES_BUTTON = `undo-changes`;

export default function AbstractPreferences(preferences, opts, deps) {
    EventEmitter.call(this);
    opts = noUndefinedGet(opts);
    this._page = deps.page;
    this._preferences = preferences;
    this._env = deps.env;
    this._rippler = deps.rippler;
    this._db = deps.db;
    this._recognizerContext = deps.recognizerContext;
    this._sliderContext = deps.sliderContext;
    this._toolbarSubmenu = deps.toolbarSubmenu;
    this._popup = deps.popupContext.makePopup(this.TITLE, this.getHtml(), opts.preferencesButton, [{
        id: RESTORE_DEFAULTS_BUTTON,
        text: `Restore defaults`,
        action: this.restoreDefaultsClicked.bind(this)
    }, {
        id: UNDO_CHANGES_BUTTON,
        text: `Undo changes`,
        action: this.undoChangesClicked.bind(this)
    }]);

    this.savePreferences = throttle(this.savePreferences, 250);


    this._manager = null;

    this.preferencesButtonClicked = this.preferencesButtonClicked.bind(this);
    this.page().$(opts.preferencesButton).addEventListener(`click`, this.preferencesButtonClicked);
    this._recognizerContext.createTapRecognizer(this.preferencesButtonClicked).recognizeBubbledOn(this.page().$(opts.preferencesButton));
    this._popup.on(`open`, this.popupOpened.bind(this));
    this._popup.on(`layoutUpdate`, this.layoutUpdated.bind(this));
    if (deps.dbValues && this.STORAGE_KEY in deps.dbValues) {
        this.preferences().copyFrom(deps.dbValues[this.STORAGE_KEY]);
        this.emit(`change`, this.preferences());
    }

}
inherits(AbstractPreferences, EventEmitter);

AbstractPreferences.prototype.preferencesButtonClicked = function(event) {
    this._toolbarSubmenu.close();
    this._popup.open();
};

AbstractPreferences.prototype.layoutUpdated = function() {
    if (this._manager) {
        this._manager.layoutUpdated();
    }
};

AbstractPreferences.prototype.popupOpened = function() {
    if (!this._manager) {
        this._manager = this._createManager();
        this._manager.on(`update`, this.savePreferences.bind(this));
    }
    this._manager.setUnchangedPreferences();
};

AbstractPreferences.prototype.page = function() {
    return this._page;
};

AbstractPreferences.prototype.env = function() {
    return this._env;
};

AbstractPreferences.prototype.sliderContext = function() {
    return this._sliderContext;
};

AbstractPreferences.prototype.rippler = function() {
    return this._rippler;
};

AbstractPreferences.prototype.db = function() {
    return this._db;
};

AbstractPreferences.prototype.recognizerContext = function() {
    return this._recognizerContext;
};

AbstractPreferences.prototype.preferences = function() {
    return this._preferences;
};

AbstractPreferences.prototype.popup = function() {
    return this._popup;
};

AbstractPreferences.prototype.restoreDefaultsClicked = function() {
    return this._manager.restoreDefaults();
};

AbstractPreferences.prototype.undoChangesClicked = function() {
    return this._manager.undoChanges();
};

AbstractPreferences.prototype.savePreferences = function() {
    this.emit(`change`, this.preferences());
    this._db.set(this.STORAGE_KEY, this.preferences().toJSON());
};

AbstractPreferences.prototype.setResetDefaultsEnabled = function(value) {
    this.popup().setButtonEnabledState(RESTORE_DEFAULTS_BUTTON, !!value);
};

AbstractPreferences.prototype.setUndoChangesEnabled = function(value) {
    this.popup().setButtonEnabledState(UNDO_CHANGES_BUTTON, !!value);
};
