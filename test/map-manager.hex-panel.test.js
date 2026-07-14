// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { MapManager } from '../app/map-manager.js';

/**
 * Hex tile layers are added at runtime, after the layer panel is built at
 * boot. These tests pin the #318 behavior: a hex layer gets its own panel row
 * with a visibility toggle and a remove button, curated layers get no remove
 * button, and removing a hex layer drops both the map layer and its row.
 */

function createPanelManager(layers = []) {
    const removed = { layers: [], sources: [] };
    const mm = Object.create(MapManager.prototype);
    mm.layers = new Map(layers);
    mm._controlsContainerEl = document.createElement('div');
    mm._refreshCycleBtnState = () => {};
    mm.map = {
        removeLayer: (id) => removed.layers.push(id),
        removeSource: (id) => removed.sources.push(id),
    };
    return { mm, removed };
}

const hexState = (displayName = 'Population density') => ({
    displayName, visible: true, versions: null,
});

describe('MapManager hex panel controls (#318)', () => {
    it('gives a hex layer a remove button; a curated layer none', () => {
        const { mm } = createPanelManager();
        const hexRow = mm._createLayerItem('hex-abc123', hexState());
        const curatedRow = mm._createLayerItem('cpad/holdings', { displayName: 'CPAD', visible: true });

        expect(hexRow.querySelector('.layer-remove-btn')).not.toBeNull();
        expect(hexRow.classList.contains('has-remove')).toBe(true);
        expect(curatedRow.querySelector('.layer-remove-btn')).toBeNull();
    });

    it('renders a visibility checkbox reflecting state.visible', () => {
        const { mm } = createPanelManager();
        const shown = mm._createLayerItem('hex-a', { ...hexState(), visible: true });
        const hidden = mm._createLayerItem('hex-b', { ...hexState(), visible: false });
        expect(shown.querySelector('input[type="checkbox"]').checked).toBe(true);
        expect(hidden.querySelector('input[type="checkbox"]').checked).toBe(false);
    });

    it('_addLayerControl appends one row and is idempotent', () => {
        const { mm } = createPanelManager([['hex-abc123', hexState()]]);
        mm._addLayerControl('hex-abc123');
        mm._addLayerControl('hex-abc123'); // second call must not duplicate
        expect(mm._controlsContainerEl.querySelectorAll('.layer-item')).toHaveLength(1);
        expect(mm._controlsContainerEl.querySelector('#layer-item-hex-abc123')).not.toBeNull();
    });

    it('_addLayerControl is a no-op before the panel is built', () => {
        const { mm } = createPanelManager([['hex-abc123', hexState()]]);
        mm._controlsContainerEl = null;
        expect(() => mm._addLayerControl('hex-abc123')).not.toThrow();
    });

    it('clicking remove tears down the map layer and its panel row', () => {
        const { mm, removed } = createPanelManager([['hex-abc123', hexState()]]);
        mm._addLayerControl('hex-abc123');
        const row = mm._controlsContainerEl.querySelector('#layer-item-hex-abc123');
        row.querySelector('.layer-remove-btn').click();

        expect(removed.layers).toEqual(['hex-abc123']);
        expect(removed.sources).toEqual(['hex-abc123']);
        expect(mm.layers.has('hex-abc123')).toBe(false);
        expect(mm._controlsContainerEl.querySelector('#layer-item-hex-abc123')).toBeNull();
    });
});
