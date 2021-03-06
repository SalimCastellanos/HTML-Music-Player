import unitBezier from "bezier";

const makeEasing = function(a, b, c, d) {
    const solver = unitBezier(a, b, c, d).duration;

    return function(current, total) {
        const progress = Math.min(1, Math.max(0, current / total));
        return solver(progress, total);
    };
};

const makeDecelator = function(power) {
    return function(current, total) {
        const progress = Math.min(1, Math.max(0, current / total));
        return 1 - Math.pow(1 - progress, power);
    };
};

const makeAccelerator = function(power) {
    return function(current, total) {
        const progress = Math.min(1, Math.max(0, current / total));
        return Math.pow(progress, power);
    };
};

export const LINEAR = `linear`;
export const SWIFT_OUT = `cubic-bezier(0.55, 0, 0.1, 1)`;
export const EASE_IN = `cubic-bezier(0.42, 0, 1, 1)`;
export const EASE_OUT = `cubic-bezier(0, 0, 0.58, 1)`;
export const EASE_IN_OUT = `cubic-bezier(0.42, 0, 0.58, 1)`;
export const EASE = `cubic-bezier(0.25, 0.1, 0.25, 1)`;
export const ACCELERATE_QUAD = `cubic-bezier(0.55, 0.085, 0.68, 0.53)`;
export const ACCELERATE_CUBIC = `cubic-bezier(0.55, 0.055, 0.675, 0.19)`;
export const ACCELERATE_QUART = `cubic-bezier(0.895, 0.03, 0.685, 0.22)`;
export const ACCELERATE_QUINT = `cubic-bezier(0.755, 0.05, 0.855, 0.06)`;
export const DECELERATE_QUAD = `cubic-bezier(0.25, 0.46, 0.45, 0.94)`;
export const DECELERATE_CUBIC = `cubic-bezier(0.215, 0.61, 0.355, 1)`;
export const DECELERATE_QUART = `cubic-bezier(0.165, 0.84, 0.44, 1)`;
export const DECELERATE_QUINT = `cubic-bezier(0.23, 1, 0.32, 1)`;

export const SWIFT_OUT_INTERPOLATOR = makeEasing(0.55, 0, 0.1, 1);
export const EASE_IN_INTERPOLATOR = makeEasing(0.42, 0, 1, 1);
export const EASE_OUT_INTERPOLATOR = makeEasing(0, 0, 0.58, 1);
export const EASE_IN_OUT_INTERPOLATOR = makeEasing(0.42, 0, 0.58, 1);
export const EASE_INTERPOLATOR = makeEasing(0.25, 0.1, 0.25, 1);
export const DECELERATE_QUAD_INTERPOLATOR = makeDecelator(2);
export const DECELERATE_CUBIC_INTERPOLATOR = makeDecelator(3);
export const DECELERATE_QUART_INTERPOLATOR = makeDecelator(4);
export const DECELERATE_QUINT_INTERPOLATOR = makeDecelator(5);
export const ACCELERATE_QUAD_INTERPOLATOR = makeAccelerator(2);
export const ACCELERATE_CUBIC_INTERPOLATOR = makeAccelerator(3);
export const ACCELERATE_QUART_INTERPOLATOR = makeAccelerator(4);
export const ACCELERATE_QUINT_INTERPOLATOR = makeDecelator(5);
