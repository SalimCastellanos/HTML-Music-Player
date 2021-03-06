import AbstractGestureRecognizer from "ui/gestures/AbstractGestureRecognizer";
import ActiveTouchList from "ui/gestures/ActiveTouchList";
import GestureObject from "ui/gestures/GestureObject";
import {TOUCH_START, TOUCH_END, TOUCH_MOVE, TOUCH_CANCEL, TOUCH_EVENTS} from "ui/gestures/GestureRecognizerContext";


export default class HoverRecognizer extends AbstractGestureRecognizer {
    constructor(recognizerContext, startHandler, endHandler) {
        super(recognizerContext);
        this.startHandler = startHandler;
        this.endHandler = endHandler;
        this.currentTouch = null;
        this.actives = new ActiveTouchList();
        this._recognizerHandler = this._recognizerHandler.bind(this);
        this._eventType = TOUCH_EVENTS;
    }

    _recognizerHandler(e) {
        const changedTouches = e.changedTouches || e.originalEvent.changedTouches;
        this.actives.update(e, changedTouches);

        if (this.getDocumentActives().length() > 1) {
            this.end(e);
            return;
        }

        if (e.type === TOUCH_START) {
            if (this.actives.length() === 1 && this.currentTouch === null) {
                this.currentTouch = this.actives.first();
                const g = new GestureObject(e, this.currentTouch);
                this.startHandler.call(e.currentTarget, g);
            } else {
                this.end(e);
            }
        } else if (e.type === TOUCH_END || e.type === TOUCH_CANCEL) {
            if (this.actives.length() !== 0 || this.currentTouch === null) {
                this.end(e);
                return;
            }
            this.end(e, changedTouches[0]);
        } else if (e.type === TOUCH_MOVE) {
            if (this.currentTouch === null || this.actives.length() !== 1) {
                this.end(e, changedTouches[0]);
                return;
            }

            const touch = changedTouches[0];
            const yDelta = Math.abs(touch.clientY - this.currentTouch.clientY);
            const xDelta = Math.abs(touch.clientX - this.currentTouch.clientX);

            if (yDelta > 25 || xDelta > 25) {
                this.end(e, touch);
            }
        }
    }

    end(e, touch) {
        if (this.currentTouch !== null) {
            const g = new GestureObject(e, touch || this.currentTouch);
            this.currentTouch = null;
            this.endHandler.call(e.currentTarget, g);
        }
    }
}
