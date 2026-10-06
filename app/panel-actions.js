/**
 * panel-actions.js — the row of panel-level buttons above the layer list.
 *
 * Shared by three features that each may or may not be present: the map-wide
 * actions built with the menu (globe, send-to-back), the optional upload
 * button, and the export button, which only appears once there is a
 * conversation to export. None of them can own the row, so whichever mounts
 * first creates it.
 *
 * It lives in its own module rather than in one of those three so importing
 * it does not drag in an unrelated feature — upload in particular is loaded
 * lazily and should stay that way.
 */

export const PANEL_ACTIONS_ID = 'panel-actions';

/**
 * Get the actions row, creating it before `controls` on first use.
 *
 * Above the list, not below it: under the basemap buttons the row stays in
 * view, where below a long layer list it scrolled out of sight and people
 * could not find export.
 *
 * @param {HTMLElement} controls — #layer-controls-container, the layer list
 *   the row sits above
 * @returns {HTMLElement}
 */
export function ensurePanelActions(controls) {
    const doc = controls.ownerDocument || document;
    const existing = doc.getElementById(PANEL_ACTIONS_ID);
    if (existing) return existing;

    const row = doc.createElement('div');
    row.id = PANEL_ACTIONS_ID;
    row.className = 'panel-actions';
    controls.before(row);
    return row;
}
