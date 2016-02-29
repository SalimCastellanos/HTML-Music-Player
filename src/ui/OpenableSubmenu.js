"use strict";

const GlobalUi = require("ui/GlobalUi");
const util = require("lib/util");
const domUtil = require("lib/DomUtil");
const features = require("features");
const touch = features.touch;

function OpenableSubmenu(dom, opener, opts) {
    opts = Object(opts);
    this._domNode = $($(dom)[0]);
    this._opener = $($(opener)[0]);
    this._keyboardElements = this.$().find("*").filter(function() {
        return this.tabIndex >= 0;
    });

    this._opened = false;

    this.activeClass = opts.activeClass || "shown";
    this.transitionClass = opts.transitionClass || "transition-in";
    this.openerActiveClass = opts.openerActiveClass || "opener-active";

    this._openerFocused = this._openerFocused.bind(this);
    this._openerClicked = this._openerClicked.bind(this);

    this._keydowned = this._keydowned.bind(this);
    this._elementBlurred = this._elementBlurred.bind(this);

    if (touch) {
        this.$opener().on(domUtil.TOUCH_EVENTS, domUtil.tapHandler(this._openerClicked));
    }

    this.$opener().on("click", this._openerClicked)
                  .on("focus", this._openerFocused);

    util.onCapture(document, "blur", this._elementBlurred);
}

OpenableSubmenu.prototype.$ = function() {
    return this._domNode;
};

OpenableSubmenu.prototype.$opener = function() {
    return this._opener;
};

OpenableSubmenu.prototype.open = function() {
    if (this._opened) return;
    this._opened = true;
    this.$opener().addClass(this.openerActiveClass);
    this.$().addClass(this.activeClass);
    this.$().width();
    var self = this;
    util.onCapture(document, "keydown", this._keydowned);
    requestAnimationFrame(function() {
        self.$().addClass(self.transitionClass);
    });
};

OpenableSubmenu.prototype.close = function() {
    if (!this._opened) return;
    this._opened = false;
    if ($(document.activeElement).closest(this.$().add(this.$opener())).length > 0) {
        document.activeElement.blur();
    }
    util.offCapture(document, "keydown", this._keydowned);
    this.$opener().removeClass(this.openerActiveClass);
    this.$().removeClass(this.activeClass).removeClass(this.transitionClass);
};

OpenableSubmenu.prototype._openerFocused = function() {
    this.open();
};

OpenableSubmenu.prototype._elementBlurred = function(e) {
    var $newFocus = $(e.relatedTarget);
    if ($newFocus.closest(this.$().add(this.$opener())).length === 0) {
        this.close();
    }
};

OpenableSubmenu.prototype._openerClicked = function(e) {
    GlobalUi.rippler.rippleElement(e.currentTarget, e.clientX, e.clientY);
    this.open();
};

OpenableSubmenu.prototype._keydowned = function(e) {
    var activeElement = document.activeElement;
    if (!activeElement) return;
    var key = e.which || e.key || e.keyIdentifier || e.keyCode;
    if (typeof key === "number") key = domUtil.whichToKey[key];


    if (key === "ArrowUp" || key === "ArrowDown") {
        var activeIndex = -1;

        this._keyboardElements.each(function(index) {
            if (this === activeElement) {
                activeIndex = index;
                return false;
            }
        });

        if (activeIndex === -1) {
            this._keyboardElements[0].focus();
        } else {
            activeIndex += (key === "ArrowUp" ? -1 : 1);
            activeIndex = Math.min(this._keyboardElements.length - 1, Math.max(0, activeIndex));
            this._keyboardElements[activeIndex].focus();
        }
    }
};


module.exports = OpenableSubmenu;