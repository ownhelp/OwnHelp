// Pure helper for the phone layout: turns the browser's visual viewport (the part of the screen
// not covered by the on-screen keyboard) into the values ChatWidget feeds to its CSS variables.
// Reading the visual viewport does not change the host page; the widget only moves its own
// fixed-position box to match it.

/** The keyboard counts as open once it hides at least this many CSS pixels of the window. */
export const KEYBOARD_MIN_PX = 120;
/** Above this scale the visitor has pinch-zoomed, and the viewport no longer describes the keyboard. */
const MAX_UNZOOMED_SCALE = 1.01;

/**
 * @param {{innerHeight: number, vvHeight: number, vvOffsetTop: number, vvScale: number}} input
 * @returns {{top: number, height: number, keyboardOpen: boolean} | null} null when the widget
 *   should fall back to plain CSS sizing (no visual viewport support, pinch-zoomed, or bad values).
 */
export function viewportBox({ innerHeight, vvHeight, vvOffsetTop, vvScale }) {
    const values = [innerHeight, vvHeight, vvOffsetTop, vvScale];
    if (!values.every((value) => Number.isFinite(value)) || vvHeight <= 0) return null;
    if (vvScale > MAX_UNZOOMED_SCALE) return null;
    return {
        top: Math.max(0, Math.round(vvOffsetTop)),
        height: Math.round(vvHeight),
        keyboardOpen: innerHeight - vvHeight >= KEYBOARD_MIN_PX,
    };
}
