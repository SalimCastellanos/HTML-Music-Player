"use strict";

const jsUtil = require("./util");
const Promise = require("../lib/bluebird");
const base64 = require("../lib/base64");
const $ = require("../lib/jquery");
const touch = require("./features").touch;
const TOUCH_START = "touchstart";
const TOUCH_END = "touchend";
const TOUCH_MOVE = "touchmove";
const TOUCH_CANCEL = "touchcancel";
const TAP_TIME = 270;
const LONG_TAP_TIME = 475;

const SWIPE_LENGTH = 0.0875;
const SWIPE_VELOCITY = 0.412;
const TWO_FINGER_TAP_MINIMUM_DISTANCE = 0.0625;
const TAP_MAX_MOVEMENT = 0.015625;
const PINCER_MINIMUM_MOVEMENT = 0.015625;
const DOUBLE_TAP_MINIMUM_MOVEMENT = 0.015625;



var util = {};
util.TOUCH_EVENTS = "touchstart touchmove touchend touchcancel";
util.TOUCH_EVENTS_NO_MOVE = "touchstart touchend touchcancel";

util.setFilter = (function() {
    var div = document.createElement("div");
    
    if ("webkitFilter" in (document.createElement("div").style)) {
        return function(elem, value) {
            elem.style.webkitFilter = value;
        };
    }

    if ("mozFilter" in (document.createElement("div").style)) {
        return function(elem, value) {
            elem.style.mozFilter = value;
        };
    }

    return function(elem, value) {
        elem.style.mozFilter = value;
    };
})();

util.getFilter = (function() {
    var div = document.createElement("div");

    if ("webkitFilter" in (document.createElement("div").style)) {
        return function(elem) {
            return elem.style ? elem.style.webkitFilter : elem.css("webkitFilter");
        };
    }

    if ("mozFilter" in (document.createElement("div").style)) {
        return function(elem) {
            return elem.style ? elem.style.mozFilter : elem.css("mozFilter");
        };
    }

    return function(elem) {
        return elem.style ? elem.style.filter : elem.css("filter");
    };
})();

util.setTransform = (function() {
    var div = document.createElement("div");
    if ("transform" in (document.createElement("div").style)) {
        return function(elem, value) {
            elem.style.transform = value;
        };
    }
    if ("webkitTransform" in (document.createElement("div").style)) {
        return function(elem, value) {
            elem.style.webkitTransform = value;
        };
    }

    return function(elem, value) {
        elem.style.mozTransform = value;
    };
})();

util.getTransform = (function() {
    var div = document.createElement("div");
    if ("transform" in (document.createElement("div").style)) {
        return function(elem) {
            return elem.style ? elem.style.transform : elem.css("transform");
        };
    }
    if ("webkitTransform" in (document.createElement("div").style)) {
        return function(elem) {
            return elem.style ? elem.style.webkitTransform : elem.css("webkitTransform");
        };
    }

    return function(elem) {
        return elem.style ? elem.style.mozTransform : elem.css("mozTransform");
    };
})();

function ActiveTouchList() {
    this.activeTouches = [];
}

ActiveTouchList.prototype.length = function() {
    return this.activeTouches.length;
};

ActiveTouchList.prototype.nth = function(i) {
    return this.activeTouches[i];
};

ActiveTouchList.prototype.first = function() {
    return this.activeTouches[0];
};

ActiveTouchList.prototype.clear = function() {
    this.activeTouches.length = 0;
};

ActiveTouchList.prototype.contains = function(touch) {
    if (!touch) return false;
    for (var i = 0; i < this.activeTouches.length; ++i) {
        if (this.activeTouches[i].identifier === touch.identifier) {
            return true;
        }
    }
    return false;
};

ActiveTouchList.prototype.update = function(e, changedTouches) {
    var activeTouches = this.activeTouches;
    var addedTouches = [];

    if (e.type === TOUCH_START) {
        for (var i = 0; i < changedTouches.length; ++i) {
            var touch = changedTouches[i];
            var unique = true;
            for (var j = 0; j < activeTouches.length; ++j) {
                if (activeTouches[j].identifier === touch.identifier) {
                    unique = false;
                }
            }

            if (unique) {
                activeTouches.push(touch);
                addedTouches.push(touch);
            }
        }
    } else if (e.type === TOUCH_END || e.type === TOUCH_CANCEL) {
        for (var i = 0; i < changedTouches.length; ++i) {
            var touch = changedTouches[i];
            var id = touch.identifier;
            for (var j = 0; j < activeTouches.length; ++j) {
                if (activeTouches[j].identifier === id) {
                    activeTouches.splice(j, 1);
                    break;
                }
            }
        }       
    }
    return addedTouches;
};

var modifierTouch = null;
var currentSingleTapTimeout = null;
const documentActives = new ActiveTouchList();

const setSingleTapTimeout = function(successHandler, clearHandler, timeout) {
    if (currentSingleTapTimeout !== null) {
        currentSingleTapTimeout.clear();
        currentSingleTapTimeout = null;
    }
    var item = {
        id: setTimeout(function() {
            currentSingleTapTimeout = null;
            successHandler();
        }, timeout),
        clear: function() {
            clearTimeout(item.id);
            clearHandler();
        }
    };
    currentSingleTapTimeout = item;
    return item.id;
};

if (touch) {
    jsUtil.onCapture(document, util.TOUCH_EVENTS, function(e) {
        if (e.cancelable) {
            e.preventDefault();
        }
        var changedTouches = e.changedTouches;
        documentActives.update(e, changedTouches);

        if (documentActives.length() > 1 && currentSingleTapTimeout !== null) {
            currentSingleTapTimeout.clear();
            currentSingleTapTimeout = null;
        }

        if (e.type === TOUCH_START) {
            if (modifierTouch === null) {
                modifierTouch = documentActives.first();
            }
        } else if (e.type === TOUCH_END || e.type === TOUCH_CANCEL) {
            if (!documentActives.contains(modifierTouch)) {
                modifierTouch = null;
            }
        } else if (e.type === TOUCH_MOVE) {
            if (modifierTouch !== null) {
                for (var i = 0; i < changedTouches.length; ++i) {
                    var touch = changedTouches[i];

                    if (touch.identifier === modifierTouch.identifier) {
                        var deltaX = Math.abs(modifierTouch.clientX - touch.clientX);
                        var deltaY = Math.abs(modifierTouch.clientY - touch.clientY);
                        if (deltaX > 35 || deltaY > 35) {
                            modifierTouch = null;
                        }
                        return;
                    }
                }
            }
        }
    });

    jsUtil.onCapture(document, [
        "gesturestart",
        "gesturechange",
        "gestureend",
        "MSGestureStart",
        "MSGestureEnd",
        "MSGestureTap",
        "MSGestureHold",
        "MSGestureChange",
        "MSInertiaStart"
    ].join(" "), function(e) {
        if (e.cancelable) {
            e.preventDefault();
        }
    });
}

const approxPhysical = (function() {
    var stride = 5;
    var map = [];
    var indices = [];
    var dpi;

    for (var i = 1; i < ((600/stride) + stride); ++i) {
        var min = i * stride;
        var max = (i + 1) * stride;
        var query = matchMedia("(min-resolution: "+min+"dpi) and (max-resolution: "+max+"dpi)");
        map[max] = query;
        indices.push(max);
    }

    var dimension;

    function refreshValues() {
        dimension = Math.min(screen.width, screen.height);
        dpi = undefined;

        for (var i = 0; i < indices.length; ++i) {
            var max = indices[i];
            var query = map[max];
            if (query.matches) {
                dpi = max - stride;
                break;
            }
        }

        if (dpi === undefined) dpi = map[indices[indices.length - 1]];
    }



    $(window).on("resize", jsUtil.throttle(function() {
        refreshValues();
    }, 350));

    refreshValues();

    return function(relativeValue) {
        return ((relativeValue * dimension / (1 / (dpi / 96)))|0);
    };
})();

util.canvasToImage = function(canvas) {
    return new Promise(function(resolve) {
        var data = canvas.toDataURL("image/png").split("base64,")[1];
        resolve(new Blob([base64.toByteArray(data)], {type: "image/png"}));
    }).then(function(blob) {
        var url = URL.createObjectURL(blob);
        var image = new Image();
        image.src = url;
        return new Promise(function (resolve, reject) {
            if (image.complete) return resolve(image);

            function cleanup() {
                image.onload = image.onerror = null;
            }

            image.onload = function() {
                cleanup();
                resolve(image);
            };
            image.onerror = function() {
                cleanup();
                reject(new Error("cannot load image"));
            };
        });
    });
};

const copyTouchProps = function(e, touch) {
    e.clientX = touch.clientX;
    e.clientY = touch.clientY;
    e.pageX = touch.pageX;
    e.pageY = touch.pageY;
    e.screenX = touch.screenX;
    e.screenY = touch.screenY;
    return e;
};

util.touchDownHandler =  function(fn) {
    var actives = new ActiveTouchList();

    return function(e) {
        var changedTouches = e.changedTouches || e.originalEvent.changedTouches;
        var newTouches = actives.update(e, changedTouches);

        if (e.type === TOUCH_START && documentActives.length() <= 1) {
            for (var i = 0; i < newTouches.length; ++i) {
                var touch = newTouches[i];
                copyTouchProps(e, touch);
                e.isFirst = touch.identifier === actives.first().identifier;
                fn.call(this, e);
            }
        }
    };
};

util.targetHoverHandler = function(fnStart, fnEnd) {
    var actives = new ActiveTouchList();
    var currentTouch = null;
    var bounds = null;

    function end(self, e, touch) {
        if (currentTouch !== null) {
            copyTouchProps(e, touch || currentTouch)
            bounds = currentTouch = null;
            fnEnd.call(self, e);
        }
    }

    return function(e) {
        var changedTouches = e.changedTouches || e.originalEvent.changedTouches;
        var targetTouches = e.targetTouches || e.originalEvent.targetTouches;

        if (e.type === TOUCH_START) {
            if (currentTouch === null && targetTouches.length > 0) {
                currentTouch = targetTouches[0];
                bounds = fnStart.call(this, e);
            }
        } else if (e.type === TOUCH_END || e.type === TOUCH_CANCEL || e.type === TOUCH_MOVE) {
            if (currentTouch !== null) {
                if (targetTouches.length === 0) {
                    end(this, e);
                    return;
                }
                for (var i = 0; i < changedTouches.length; ++i) {
                    if (changedTouches[i].identifier === currentTouch.identifier) {
                        var touch = changedTouches[i];
                        var x = touch.clientX;
                        var y = touch.clientY;

                        if (!(x >= bounds.left && x <= bounds.right &&
                            y >= bounds.top && y <= bounds.bottom)) {
                            end(this, e);
                        }
                        return;
                    }
                }
            }
        }
    };
};

util.hoverHandler = function(fnStart, fnEnd) {
    var actives = new ActiveTouchList();
    var currentTouch = null;

    function end(self, e, touch) {
        if (currentTouch !== null) {
            copyTouchProps(e, touch || currentTouch)
            currentTouch = null;
            fnEnd.call(self, e);
        }
    }

    return function(e) {
        var changedTouches = e.changedTouches || e.originalEvent.changedTouches;
        actives.update(e, changedTouches);

        if (documentActives.length() > 1) {
            end(this, e);
            return;
        }

        if (e.type === TOUCH_START) {
            if (actives.length() === 1 && currentTouch === null) {
                currentTouch = actives.first();
                copyTouchProps(e, currentTouch);
                fnStart.call(this, e);
            } else {
                end(this, e);
            }
        } else if (e.type === TOUCH_END || e.type === TOUCH_CANCEL) {
            if (actives.length() !== 0 || currentTouch === null) {
                end(this, e);
                return;
            }
            end(this, e, changedTouches[0]);
        } else if (e.type === TOUCH_MOVE) {
            if (currentTouch === null || actives.length() !== 1) {
                end(this, e, changedTouches[0]);
                return;
            }

            var touch = changedTouches[0];
            var yDelta = Math.abs(touch.clientY - currentTouch.clientY);
            var xDelta = Math.abs(touch.clientX - currentTouch.clientX);

            if (yDelta > 25 || xDelta > 25) {
                end(this, e, touch);
            }
        }
    };
};

util.tapHandler = function(fn) {
    var actives = new ActiveTouchList();
    var currentTouch = null;
    var started = -1;

    function clear() {
        currentTouch = null;
        started = -1;
    }

    return function(e) {
        var changedTouches = e.changedTouches || e.originalEvent.changedTouches;
        actives.update(e, changedTouches);

        if (e.type === TOUCH_START) {
            if (actives.length() <= 1) {
                started = Date.now();
                currentTouch = actives.first();
            } else {
                clear();
            }

        } else if (e.type === TOUCH_END || e.type === TOUCH_CANCEL) {
            if (actives.length() !== 0 || currentTouch === null || documentActives.length() !== 0) {
                clear();
                return;
            }

            var touch = changedTouches[0];
            var yDelta = Math.abs(touch.clientY - currentTouch.clientY);
            var xDelta = Math.abs(touch.clientX - currentTouch.clientX);
            var elapsed = Date.now() - started;

            if (elapsed > 20 && elapsed < TAP_TIME && xDelta <= 25 && yDelta <= 25) {
                copyTouchProps(e, touch);
                fn.call(this, e);
            }
            clear();
        } else if (e.type === TOUCH_MOVE) {
            if (documentActives.length() > 1) {
                clear();
            }
        }
    };
};

util.twoFingerTapHandler = function(fn) {
    var actives = new ActiveTouchList();
    var currentATouch = null;
    var currentBTouch = null;
    var started = -1;

    function clear() {
        currentATouch = currentBTouch = null;
        started = -1;
    }

    function maybeStart() {
        var deltaX = Math.abs(currentATouch.clientX - currentBTouch.clientX);
        var deltaY = Math.abs(currentATouch.clientY - currentBTouch.clientY);
        // Fingers are too close together.
        if (deltaX > approxPhysical(TWO_FINGER_TAP_MINIMUM_DISTANCE) ||
            deltaY > approxPhysical(TWO_FINGER_TAP_MINIMUM_DISTANCE)) {
            if (started === -1) {
                started = Date.now();
            }
        } else {
            clear();
        }
    }

    function checkDelta(changedTouches) {
        for (var i = 0; i < changedTouches.length; ++i) {
            var touch = changedTouches[i];
            if (touch.identifier === currentATouch.identifier) {
                var yDelta = Math.abs(touch.clientY - currentATouch.clientY);
                var xDelta = Math.abs(touch.clientX - currentATouch.clientX);
                // First finger moved too much while tapping.
                if (xDelta > approxPhysical(TAP_MAX_MOVEMENT) ||
                    yDelta > approxPhysical(TAP_MAX_MOVEMENT)) {
                    clear();
                    return false;
                }
            } else if (touch.identifier === currentBTouch.identifier) {
                var yDelta = Math.abs(touch.clientY - currentBTouch.clientY);
                var xDelta = Math.abs(touch.clientX - currentBTouch.clientX);
                // Second finger moved too much while tapping.
                if (xDelta > approxPhysical(TAP_MAX_MOVEMENT) ||
                    yDelta > approxPhysical(TAP_MAX_MOVEMENT)) {
                    clear();
                    return false;
                }
            }
        }
        return true;
    }

    return function(e) {
        var changedTouches = e.changedTouches || e.originalEvent.changedTouches;
        actives.update(e, changedTouches);

        if (documentActives.length() > 2) {
            clear();
            return;
        }

        if (e.type === TOUCH_START) {
            if (actives.length() <= 2) {
                currentATouch = actives.first() || null;
                if (actives.length() > 1) {
                    currentBTouch = actives.nth(1) || null;
                }
            } else {
                clear();
            }

            if (currentATouch !== null && currentBTouch === null) {
                started = Date.now();
            } else if (currentATouch !== null && currentBTouch !== null) {
                maybeStart();
            }
        } else if (e.type === TOUCH_END || e.type === TOUCH_CANCEL) {
            if (currentATouch === null || currentBTouch === null) {
                clear();
                return;
            }

            if (actives.length() <= 1 && !checkDelta(changedTouches)) {
                return;
            } else if (actives.length() > 1 || documentActives.length() > 1) {
                clear();
                return;
            }

            if (actives.length() !== 0) return;

            var elapsed = (e.timeStamp || e.originalEvent.timeStamp) - started;
            if (elapsed > 20 && elapsed < TAP_TIME) {
                fn.call(this, currentATouch, currentBTouch);
            }
            clear();
        } else if (e.type === TOUCH_MOVE) {
            if (documentActives.length() > 2) {
                clear();
            }
        }
    };
};

util.modifierTapHandler = function(fn) {
    var currentTouch = null;
    var started = -1;

    function clear() {
        currentTouch = null;
        started = -1;
    }

    return function(e) {
        var changedTouches = e.changedTouches || e.originalEvent.changedTouches;

        if (modifierTouch === null) {
            return clear();
        }

        if (e.type === TOUCH_START) {
            if (documentActives.length() !== 2) {
                return clear();
            }

            for (var i = 0; i < changedTouches.length; ++i) {
                if (changedTouches[i].identifier !== modifierTouch.identifier) {
                    started = Date.now();
                    currentTouch = changedTouches[i];
                    return;
                }
            }
            clear();
        } else if (e.type === TOUCH_END || e.type === TOUCH_CANCEL) {
            if (currentTouch === null) return;
            if (documentActives.length() !== 1) {
                return clear();
            }
            var touch = null;
            for (var i = 0; i < changedTouches.length; ++i) {
                if (changedTouches[i].identifier === currentTouch.identifier) {
                    touch = changedTouches[i];
                    break;
                }
            }

            if (!touch) {
                return clear();
            }

            var yDelta = Math.abs(touch.clientY - currentTouch.clientY);
            var xDelta = Math.abs(touch.clientX - currentTouch.clientX);
            var elapsed = Date.now() - started;

            if (elapsed > 20 && elapsed < TAP_TIME && xDelta <= 25 && yDelta <= 25) {
                copyTouchProps(e, touch);
                fn.call(this, e);
            }
            clear();
        } else if (e.type === TOUCH_MOVE) {
            if (documentActives.length() !== 2) {
                return clear();
            }
        }
    };
};

util.modifierDragHandler = function(fnMove, fnEnd) {
    var currentTouch = null;

    function end(self, e, touch) {
        if (currentTouch !== null) {
            copyTouchProps(e, touch || currentTouch);
            currentTouch = null;
            fnEnd.call(self, e);
        }
    }

    return function(e) {
        if (modifierTouch === null || documentActives.length() > 2) {
            return end(this, e);
        }
        
        var changedTouches = e.changedTouches || e.originalEvent.changedTouches;

        if (e.type === TOUCH_START) {
            for (var i = 0; i < changedTouches.length; ++i) {
                if (changedTouches[i].identifier !== modifierTouch.identifier) {
                    currentTouch = changedTouches[i];
                    return;
                }
            }
            end(this, e);
        } else if (e.type === TOUCH_END || e.type === TOUCH_CANCEL) {
            end(this, e);
        } else if (e.type === TOUCH_MOVE) {
            if (currentTouch === null) return;

            var touch = null;
            for (var i = 0; i < changedTouches.length; ++i) {
                if (changedTouches[i].identifier === currentTouch.identifier) {
                    touch = changedTouches[i];
                    break;
                }
            }

            if (touch === null) return;

            var yDelta = Math.abs(touch.clientY - currentTouch.clientY);
            var xDelta = Math.abs(touch.clientX - currentTouch.clientX);

            if (yDelta > 0 || xDelta > 0) {
                currentTouch = touch;
                copyTouchProps(e, currentTouch);
                fnMove.call(this, e);
            }
        }
    };
};

util.modifierTouchDownHandler = function(fn) {
    return function(e) {
        if (modifierTouch === null || documentActives.length() > 2) return;
        var changedTouches = e.changedTouches || e.originalEvent.changedTouches;



        if (e.type === TOUCH_START) {
            for (var i = 0; i < changedTouches.length; ++i) {
                var touch = changedTouches[i];
                if (touch.identifier !== modifierTouch.identifier) {
                    copyTouchProps(e, touch);
                    e.isFirst = true;
                    fn.call(this, e);
                    break;
                }
            }
        }
    };
};


util.dragHandler = function(fnMove, fnEnd) {
    var actives = new ActiveTouchList();
    var currentTouch = null;

    function end(self, e, touch) {
        if (currentTouch !== null) {
            copyTouchProps(e, touch || currentTouch);
            currentTouch = null;
            fnEnd.call(self, e);
        }
    }

    return function(e) {
        var changedTouches = e.changedTouches || e.originalEvent.changedTouches;
        actives.update(e, changedTouches);

        if (documentActives.length() > 1) {
            end(this, e);
            return;
        }

        if (e.type === TOUCH_START) {
            currentTouch = actives.first();
        } else if (e.type === TOUCH_END || e.type === TOUCH_CANCEL) {
            if (actives.length() > 0) {
                currentTouch = actives.first();
            } else {
                end(this, e, currentTouch);
                currentTouch = null;
            }
        } else if (e.type === TOUCH_MOVE) {
            if (!actives.contains(currentTouch) || actives.length() > 1 || documentActives.length() > 1) {
                return;
            }

            var touch = changedTouches[0];
            var yDelta = Math.abs(touch.clientY - currentTouch.clientY);
            var xDelta = Math.abs(touch.clientX - currentTouch.clientX);

            if (yDelta > 2 || xDelta > 2) {
                currentTouch = touch;
                copyTouchProps(e, currentTouch);
                fnMove.call(this, e);
            }
        }
    };
};

util.verticalPincerSelectionHandler = function(fn) {
    var started = -1;
    var currentATouch = null;
    var currentBTouch = null;
    var callback = fn;
    var aChanged = false;
    var bChanged = false;
    var actives = new ActiveTouchList();

    function clear() {
        currentATouch = currentBTouch = null;
        aChanged = bChanged = false;
        started = -1;
    }

    return function(e) {
        var changedTouches = e.changedTouches || e.originalEvent.changedTouches;
        var selecting = false;
        actives.update(e, changedTouches);

        if (documentActives.length() > 2) {
            clear();
            return;
        }

        if (e.type === TOUCH_START) {
            if (actives.length() <= 2) {
                currentATouch = actives.first() || null;
                if (actives.length() > 1) {
                    currentBTouch = actives.nth(1) || null;
                }
            }
            started = currentATouch !== null && currentBTouch !== null ? (e.timeStamp || e.originalEvent.timeStamp) : -1;
        } else if (e.type === TOUCH_END || e.type === TOUCH_CANCEL) {
            if (!actives.contains(currentATouch) || !actives.contains(currentBTouch)) {
                clear();
            }
        } else if (e.type === TOUCH_MOVE) {
            if (actives.length() !== 2 ||
                !actives.contains(currentATouch) ||
                !actives.contains(currentBTouch) ||
                documentActives.length() > 2) {
                return;
            }

            if (!aChanged || !bChanged) {
                for (var i = 0; i < changedTouches.length; ++i) {
                    var touch = changedTouches[i];

                    if (touch.identifier === currentATouch.identifier) {
                        var delta = Math.abs(touch.clientY - currentATouch.clientY);
                        if (delta > 25) {
                            aChanged = true;
                            currentATouch = touch;
                        }
                    } else if (touch.identifier === currentBTouch.identifier) {
                        var delta = Math.abs(touch.clientY - currentATouch.clientY);
                        if (delta > 25) {
                            bChanged = true;
                            currentBTouch = touch;
                        }
                    }

                    if (aChanged && bChanged) {
                        break;
                    }
                }
            }

            if ((aChanged || bChanged) &&
                started !== -1 &&
                ((e.timeStamp || e.originalEvent.timeStamp) - started) > (TAP_TIME * 2)) {
                aChanged = bChanged = false;
                var start, end;

                if (currentATouch.clientY > currentBTouch.clientY) {
                    start = currentBTouch;
                    end = currentATouch;
                } else {
                    start = currentATouch;
                    end = currentBTouch;
                }
                callback(start.clientY, end.clientY);
            }
        }
    };
};

util.horizontalSwipeHandler = function(fn, direction) {
    var startX = -1;
    var lastX = -1;
    var previousTime = -1;
    var elapsedTotal = 0;

    const clear = function() {
        previousTime = -1;
        startX = -1;
        lastX = -1;
        elapsedTotal = 0;
    };

    return util.dragHandler(function(e) {
        if (startX === -1) {
            startX = e.clientX;
        } else {
            var now = (e.timeStamp || e.originalEvent.timeStamp);
            elapsedTotal += (now - previousTime);
            if ((direction < 0 && e.clientX - lastX > 0) ||
                (direction > 0 && e.clientX - lastX < 0)) {
                clear();
            }
        }
        lastX = e.clientX;
        previousTime = e.timeStamp || e.originalEvent.timeStamp;
    }, function(e) {
        if (startX !== -1 && elapsedTotal > 10) {
            var diff = e.clientX - startX;
            var absDiff = Math.abs(diff);
            var minSwipeLength = approxPhysical(SWIPE_LENGTH);
            var velocity = (absDiff / elapsedTotal * 1000)|0;

            if (absDiff > minSwipeLength &&
                velocity > approxPhysical(SWIPE_VELOCITY) &&
                (diff < 0 && direction < 0 ||
                diff > 0 && direction > 0)) {
                fn.call(this, e);
            }
        }
        clear();
    });
};

util.horizontalTwoFingerSwipeHandler = function(fn, direction) {
    var actives = new ActiveTouchList();
    var currentATouch = null;
    var currentBTouch = null;

    var startAX = -1;
    var startBX = -1;
    var lastAY = -1;
    var lastAX = -1;
    var lastBX = -1;
    var lastBY = -1;

    var previousTime = -1;
    var elapsedTotal = 0;

    const clear = function() {
        previousTime = -1;
        currentATouch = currentBTouch = null;
        lastAY = lastBY = startAX = startBX = lastAX = lastBX = -1;
        elapsedTotal = 0;
    };

    const checkCompletion = function() {
        if (startAX !== -1 && startBX !== -1 && documentActives.length() === 0) {
            var aDiff = lastAX - startAX;
            var bDiff = lastBX - startBX;
            var aAbsDiff = Math.abs(aDiff);
            var bAbsDiff = Math.abs(bDiff);
            var aVelocity = (aAbsDiff / elapsedTotal * 1000)|0;
            var bVelocity = (bAbsDiff / elapsedTotal * 1000)|0;

            var minSwipeLength = approxPhysical(SWIPE_LENGTH);

            if (aAbsDiff > minSwipeLength &&
                bAbsDiff > minSwipeLength &&
                aVelocity > approxPhysical(SWIPE_VELOCITY) &&
                bVelocity > approxPhysical(SWIPE_VELOCITY) &&
                (aDiff < 0 && bDiff < 0 && direction < 0 ||
                aDiff > 0 && bDiff > 0 && direction > 0) &&
                Math.abs(aAbsDiff - bAbsDiff) <= 150) {
                fn.call(this);
            }
        }
        clear();
    };

    return function(e) {
        var now = (e.timeStamp || e.originalEvent.timeStamp);
        var changedTouches = e.changedTouches || e.originalEvent.changedTouches;
        actives.update(e, changedTouches);

        if (documentActives.length() > 2) {
            clear();
            return;
        }

        if (e.type === TOUCH_START) {
            if (actives.length() === 1) {
                currentATouch = actives.first();
                startAX = currentATouch.clientX;
                lastAX = startAX;
                lastAY = currentATouch.clientY;
                previousTime = now;
            } else if (actives.length() === 2 && currentATouch !== null) {
                elapsedTotal += (now - previousTime);
                previousTime = now;
                currentBTouch = actives.nth(1);
                startBX = currentBTouch.clientX;
                lastBX = startBX;
                lastBY = currentBTouch.clientY;
                if (lastAX !== -1 &&
                    (Math.abs(lastAX - lastBX) > 150 &&
                        Math.abs(lastAY - lastBY) > 150)) {
                    clear();
                }
            } else {
                clear();
            }
        } else if (e.type === TOUCH_END || e.type === TOUCH_CANCEL) {
            if (currentATouch === null || currentBTouch === null) return;
            for (var i = 0; i < changedTouches.length; ++i) {
                var touch = changedTouches[i];
                if (touch.identifier === currentATouch.identifier) {
                    lastAX = touch.clientX;
                } else if (touch.identifier === currentBTouch.identifier) {
                    lastBX = touch.clientX;
                }
            }
            if (actives.length() === 0) {
                checkCompletion();
                clear();
            }
        } else if (e.type === TOUCH_MOVE) {
            if (documentActives.length() > 2) {
                clear();
                return;
            };
            if (currentATouch !== null || currentBTouch !== null) {
                var now = (e.timeStamp || e.originalEvent.timeStamp);
                elapsedTotal += (now - previousTime);

                for (var i = 0; i < changedTouches.length; ++i) {
                    var touch = changedTouches[i];

                    if (currentATouch !== null && touch.identifier === currentATouch.identifier) {
                        lastAX = touch.clientX;
                        lastAY = touch.clientY;
                    } else if (currentBTouch !== null && touch.identifier === currentBTouch.identifier) {
                        lastBX = touch.clientX;
                        lastBY = touch.clientY;
                    } 
                }

                if (lastAX !== -1 && lastBX !== -1 && 
                    (Math.abs(lastAX - lastBX) > 150 &&
                     Math.abs(lastAY - lastBY) > 150)) {
                    clear();
                }
                previousTime = now;
            }
        }
    };
};

util.longTapHandler = function(fn) {
    var actives = new ActiveTouchList();
    var currentTouch = null;
    var timeoutId = -1;

    function clear() {
        if (timeoutId !== -1) {
            clearTimeout(timeoutId);
            timeoutId = -1;
        }
        currentTouch = null;
    }

    return function(e) {
        var changedTouches = e.changedTouches || e.originalEvent.changedTouches;
        actives.update(e, changedTouches);

        if (e.type === TOUCH_START) {
            if (documentActives.length() === 1 && currentTouch === null) {
                currentTouch = actives.first();
                timeoutId = setSingleTapTimeout(function() {
                    if (documentActives.length() <= 1) {
                        var touch = currentTouch;
                        copyTouchProps(e, touch);
                        clear();
                        fn.call(self, e);
                    }
                }, clear, LONG_TAP_TIME);
            } else {
                clear();
            }
        } else if (e.type === TOUCH_MOVE) {
            var touch = changedTouches[0];
            if (actives.length() !== 1 || !actives.contains(currentTouch) || !actives.contains(touch)) {
                clear();
                return;
            }
            var yDelta = Math.abs(touch.clientY - currentTouch.clientY);
            var xDelta = Math.abs(touch.clientX - currentTouch.clientX);
            currentTouch = touch;

            if (xDelta > 2 || yDelta > 2) {
                clear();
            }
        } else if (e.type === TOUCH_END || e.type === TOUCH_CANCEL) {
            clear();
        } else if (e.type === TOUCH_MOVE) {
            if (documentActives.length() > 1) {
                clear();
            }
        }
    };
};

util.doubleTapHandler = function(fn) {
    var lastTap = -1;
    var lastTouch;
    return util.tapHandler(function(e) {
        var changedTouches = e.changedTouches || e.originalEvent.changedTouches;

        var now = Date.now();
        if (lastTap === -1) {
            lastTap = now;
            lastTouch = changedTouches[0];
        } else if (now - lastTap < TAP_TIME) {
            var touch = lastTouch;
            lastTouch = null;
            var yDelta = Math.abs(touch.clientY - changedTouches[0].clientY);
            var xDelta = Math.abs(touch.clientX - changedTouches[0].clientX);
            lastTap = -1;
            if (yDelta < approxPhysical(DOUBLE_TAP_MINIMUM_MOVEMENT) &&
                xDelta < approxPhysical(DOUBLE_TAP_MINIMUM_MOVEMENT)) {
                return fn.apply(this, arguments);
            }
        } else {
            lastTouch = changedTouches[0];
            lastTap = now;
        }
    });
};

util.bindScrollerEvents = function(target, scroller, shouldScroll, scrollbar) {
    if (!shouldScroll) shouldScroll = function() {return true; };
    scrollbar = $($(scrollbar)[0]);
    var events = "touchstart touchend touchmove touchcancel".split(" ").map(function(v) {
        return v + ".scrollerns";
    }).join(" ");

    var actives = new ActiveTouchList();
    var scrollerTouch = null;
    var mousedown = false;
    var prevTimestamp = 0;

    target.on(events, function(e) {
        var changedTouches = e.changedTouches || e.originalEvent.changedTouches;
        var timeStamp = e.timeStamp || e.originalEvent.timeStamp;
        var elapsed = timeStamp - prevTimestamp;
        prevTimestamp = timeStamp;

        actives.update(e, changedTouches);
        if (!shouldScroll()) {
            return;
        }
        switch (e.type) {
        case TOUCH_START:
            if (actives.length() === 1) {
                scrollerTouch = actives.first();
                return scroller.doTouchStart([scrollerTouch], timeStamp);
            }
            return;
        case TOUCH_END:
        case TOUCH_CANCEL:
            if (scrollerTouch !== null && !actives.contains(scrollerTouch)) {
                scroller.doTouchEnd(timeStamp);
                scrollerTouch = null;
            }
            return;
        case TOUCH_MOVE:
            if (!actives.contains(scrollerTouch)) return;
            if (documentActives.length() > 1) {
                scroller.doTouchEnd(timeStamp);
                scroller.doTouchStart([scrollerTouch], timeStamp);
                scroller.doTouchEnd(timeStamp);
                return;
            }
            var touch;
            for (var i = 0; i < changedTouches.length; ++i) {
                var cTouch = changedTouches[i];
                if (cTouch.identifier === scrollerTouch.identifier) {
                    touch = cTouch;
                    scrollerTouch = touch;
                    break;
                }
            }
            if (touch) {
                return scroller.doTouchMove([touch], timeStamp, e.scale || e.originalEvent.scale);
            }
            return;
        }
    });

    var wheelEvents = "wheel mousewheel DOMMouseScroll".split(" ").map(function(v) {
        return v + ".scrollerns";
    }).join(" ");

    target.on(wheelEvents, util.mouseWheelScrollHandler(function(delta) {
        scroller.scrollBy(0, delta, true);
    }));
};

util.unbindScrollerEvents = function(target, scrollbar, scroller) {
    target.off(".scrollerns");
};

util.mouseWheelScrollHandler = function(fn) {
    return function(e) {
        if (e.originalEvent) e = e.originalEvent;
        e.preventDefault();
        e.stopPropagation();

        var delta;
        if (e.deltaY !== undefined) {
            delta = -e.deltaY * (e.deltaMode === 1 ? 20 : 1);
        } else if (e.wheelDeltaY !== undefined) {
            delta = e.wheelDeltaY / 6;
        } else if (e.wheelDelta !== undefined) {
            delta = e.wheelDelta / 6;
        } else {
            delta = -e.detail * 6.67;
        }
        fn(delta * -1);
    };
};

var rafCallbacks = [];
var rafId = -1;
var rafCallback = function(now) {
    rafId = -1;
    for (var i = 0; i < rafCallbacks.length; ++i) {
        rafCallbacks[i].call(null, now);
    }
    rafCallbacks.length = 0;
};

util.changeDom = function(callback) {
    if (typeof callback !== "function") throw new Error("callback must be a function");
    for (var i = 0; i < rafCallbacks.length; ++i) {
        if (rafCallbacks[i] === callback) return;
    }
    rafCallbacks.push(callback);
    if (rafId === -1) {
        rafId = requestAnimationFrame(rafCallback);
    }
};


var rtouchevent = /^touch/;
util.isTouchEvent = function(e) {
    return rtouchevent.test(e.type);
};

module.exports = util;
