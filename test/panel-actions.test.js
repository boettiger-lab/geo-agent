// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { ensurePanelActions, PANEL_ACTIONS_ID } from '../app/panel-actions.js';

/** The shared actions row: under the basemap buttons, above the layer list. */
describe('ensurePanelActions', () => {
    let basemap, controls;
    beforeEach(() => {
        document.body.innerHTML =
            '<div id="menu-body"><div class="menu-section" id="basemap"></div>' +
            '<div class="menu-section"><div id="layer-controls-container"></div></div></div>';
        basemap = document.getElementById('basemap');
        controls = document.getElementById('layer-controls-container');
    });

    it('puts the row directly above the layer list', () => {
        const row = ensurePanelActions(controls);
        expect(row.id).toBe(PANEL_ACTIONS_ID);
        expect(row.nextElementSibling).toBe(controls);
        // …so it comes after the basemap buttons in document order.
        expect(basemap.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('returns the same row to every caller', () => {
        const a = ensurePanelActions(controls);
        expect(ensurePanelActions(controls)).toBe(a);
        expect(document.querySelectorAll(`#${PANEL_ACTIONS_ID}`).length).toBe(1);
    });
});
