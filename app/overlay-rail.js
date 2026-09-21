/**
 * overlay-rail.js — the shared rail for map-scoped overlay panels.
 *
 * Before this module every floating panel anchored itself to the map's
 * bottom-left corner with its own `position: absolute; bottom; left`, and the
 * two that knew about each other (`.anim-controls`, `.reactive-controls`)
 * hand-computed `bottom = 12 + n * 44` at construction time. That arrangement
 * had three failure modes:
 *
 *   - panels that didn't know about each other simply overlapped (#359: the
 *     legend painting over the reactive-control slider in sidebar mode),
 *   - the offset was computed once, so destroying a panel left a hole and the
 *     next panel to mount collided with a survivor,
 *   - fixing it meant another round of z-index escalation, which only changes
 *     *which* panel is unreachable.
 *
 * Instead, every map-scoped panel mounts into one bottom-anchored flex column
 * and the browser does the stacking. Panels appear in `SLOT` order regardless
 * of mount order, removal reflows the rest automatically, and the whole rail
 * carries a single z-index — so there is nothing left to escalate.
 *
 * The rail is created lazily on first mount: a deployment with no overlay
 * panels never gets the element.
 *
 * Panels remain responsible for their own removal (`el.remove()`); the rail
 * holds no registry and needs no teardown.
 */

export const RAIL_ID = 'map-overlay-rail';

/**
 * Vertical order within the rail, top of the column first.
 *
 * Values are spaced so a new panel type can be slotted between two existing
 * ones without renumbering. The ordering principle: compact, always-present
 * affordances sit nearest the corner where they're easy to hit, and tall or
 * transient panels stack above them.
 */
export const SLOT = {
    LEGEND: 10,      // tall, shrinks first — see the flex rules in style.css
    REACTIVE: 20,    // reactive-parameter sliders (#147)
    ANIMATION: 30,   // trajectory playback controls
    HEX_BADGE: 40,   // H3 resolution readout, sits directly above its toggle
    HEX_TOGGLE: 50,  // bottom of the column, nearest the map corner
};

/**
 * Get the rail element, creating it on first use.
 *
 * @param {Document} doc
 * @returns {HTMLElement}
 */
export function ensureRail(doc = document) {
    let rail = doc.getElementById(RAIL_ID);
    if (!rail) {
        rail = doc.createElement('div');
        rail.id = RAIL_ID;
        doc.body.appendChild(rail);
    }
    return rail;
}

/**
 * Mount a panel into the rail at the given slot.
 *
 * Replaces a bare `document.body.appendChild(panel)` plus whatever manual
 * `bottom` arithmetic the caller used to do. Mounting an element that is
 * already in the rail just updates its slot.
 *
 * @param {HTMLElement} el — the panel
 * @param {number} slot — a `SLOT` value
 * @param {Document} [doc] — defaults to the element's own document
 * @returns {HTMLElement} the rail, for callers that want to inspect it
 */
export function mountOverlay(el, slot, doc = el.ownerDocument || document) {
    const rail = ensureRail(doc);
    el.style.order = String(slot);
    rail.appendChild(el);
    return rail;
}
