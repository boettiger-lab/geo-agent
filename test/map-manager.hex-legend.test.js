// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { MapManager } from '../app/map-manager.js';
import { PALETTES } from '../app/hex-layer-helpers.js';

/**
 * Hex tile layers style with a per-`res` `match` expression that the
 * continuous-legend deriver doesn't cover, so they historically rendered no
 * legend (#316). These tests pin the hex-specific, zoom-reactive legend:
 * palette + the value domain of the resolution actually on screen.
 */

function hexState(overrides = {}) {
    return {
        layerId: 'hex-abc', mapLayerId: 'hex-abc', displayName: 'Population',
        visible: true, type: 'vector', legendType: 'hex', legendLabel: null,
        legendClasses: null,
        hexValueStats: { by_res: { '5': { min: 0, max: 100 }, '6': { min: 0, max: 700 }, '7': { min: 0, max: 4900 } } },
        hexPalette: 'viridis', hexCurrentRes: null,
        ...overrides,
    };
}

function createManager(state, renderedRes = null) {
    const handlers = {};
    const mm = Object.create(MapManager.prototype);
    mm.layers = new Map([[state.layerId, state]]);
    mm._legendItems = new Map();
    mm._hexLegendRefs = new Map();
    mm._hexLegendReactive = false;
    mm._legendEl = null;
    mm._legendContent = null;
    mm._ensureLegend = function () {
        if (this._legendEl) return;
        this._legendEl = document.createElement('div');
        this._legendContent = document.createElement('div');
    };
    let res = renderedRes;
    mm.map = {
        on: (ev, cb) => { handlers[ev] = cb; },
        removeLayer: () => {},
        removeSource: () => {},
        queryRenderedFeatures: () => res == null ? [] : [{ properties: { res } }, { properties: { res } }],
        setRenderedRes: (r) => { res = r; },
    };
    return { mm, handlers };
}

describe('MapManager hex legend (#316)', () => {
    it('_hasLegend is true for a hex layer with resolution stats', () => {
        const { mm } = createManager(hexState());
        expect(mm._hasLegend(hexState())).toBe(true);
    });

    it('_hasLegend is false for a hex layer with no resolution stats', () => {
        const { mm } = createManager(hexState());
        expect(mm._hasLegend(hexState({ hexValueStats: { by_res: {} } }))).toBe(false);
    });

    it('_currentHexRes picks the dominant rendered resolution', () => {
        const state = hexState();
        const { mm } = createManager(state, 6);
        expect(mm._currentHexRes(state)).toBe(6);
    });

    it('_currentHexRes falls back to the finest resolution when nothing is rendered', () => {
        const state = hexState();
        const { mm } = createManager(state, null);
        expect(mm._currentHexRes(state)).toBe(7);
    });

    it('_hexLegend returns the palette + the current resolution domain', () => {
        const state = hexState();
        const { mm } = createManager(state, 6);
        const legend = mm._hexLegend(state);
        expect(legend.colors).toEqual(PALETTES.viridis);
        expect(legend.range).toEqual([0, 700]);
        expect(legend.res).toBe(6);
    });

    it('_showLegend renders a colorbar, min/max labels, and a resolution note', async () => {
        const state = hexState();
        const { mm } = createManager(state, 6);
        await mm._showLegend('hex-abc');
        const item = mm._legendItems.get('hex-abc');
        expect(item.querySelector('.legend-colorbar')).not.toBeNull();
        const labels = [...item.querySelectorAll('.legend-labels span')].map(s => s.textContent);
        expect(labels).toEqual(['0', '700']);
        expect(item.querySelector('.legend-hex-res').textContent).toBe('H3 resolution 6');
        expect(mm._hexLegendRefs.has('hex-abc')).toBe(true);
        expect(mm._hexLegendReactive).toBe(true);
    });

    it('_updateHexLegends relabels to the new resolution domain on zoom', async () => {
        const state = hexState();
        const { mm, handlers } = createManager(state, 6);
        await mm._showLegend('hex-abc');
        mm.map.setRenderedRes(7);           // user zooms in → finer resolution served
        handlers.moveend();                 // the registered moveend fires
        const item = mm._legendItems.get('hex-abc');
        const labels = [...item.querySelectorAll('.legend-labels span')].map(s => s.textContent);
        expect(labels).toEqual(['0', '4,900']);
        expect(item.querySelector('.legend-hex-res').textContent).toBe('H3 resolution 7');
    });

    it('removeHexTileLayer clears the legend entry and refs', async () => {
        const state = hexState();
        const { mm } = createManager(state, 6);
        await mm._showLegend('hex-abc');
        mm.removeHexTileLayer('hex-abc');
        expect(mm._legendItems.has('hex-abc')).toBe(false);
        expect(mm._hexLegendRefs.has('hex-abc')).toBe(false);
    });

    it('_fmtLegendValue groups integers and trims floats', () => {
        const { mm } = createManager(hexState());
        expect(mm._fmtLegendValue(1234567)).toBe('1,234,567');
        expect(mm._fmtLegendValue(12.3456)).toBe('12.3');
        expect(mm._fmtLegendValue(0.0012345)).toBe('0.00123');
    });
});
