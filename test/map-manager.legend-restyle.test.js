// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { MapManager } from '../app/map-manager.js';
import { PALETTES } from '../app/hex-layer-helpers.js';

/**
 * Legends are derived from paint, but `set_style` used to leave them alone —
 * so an agent restyle left the colorbar describing the ramp the layer was
 * registered with, or produced a choropleth with no legend at all (#333).
 * These tests pin that a legend always describes the paint currently on the map.
 */

function createManager(states) {
    const painted = {};
    const mm = Object.create(MapManager.prototype);
    mm.layers = new Map(states.map(s => [s.layerId, s]));
    mm._legendItems = new Map();
    mm._legendGroups = new Map();
    mm._hexLegendRefs = new Map();
    mm._hexLegendReactive = true;   // suppress the lazy moveend wiring
    mm._legendEl = null;
    mm._legendContent = null;
    mm._ensureLegend = function () {
        if (this._legendEl) return;
        this._legendEl = document.createElement('div');
        this._legendContent = document.createElement('div');
        this._legendEl.appendChild(this._legendContent);
        document.body.appendChild(this._legendEl);
    };
    // Raster colorbars fetch a TiTiler colormap; the restyle path only needs a
    // deterministic gradient string.
    mm._getColormapGradient = async () => 'linear-gradient(to right, #eee, #333)';
    mm.map = {
        on: () => {},
        setPaintProperty: (id, prop, value) => { painted[`${id}:${prop}`] = value; },
        setLayoutProperty: () => {},
        setFilter: () => {},
        getLayer: () => ({ type: 'fill' }),
        queryRenderedFeatures: () => [{ properties: { res: 6 } }],
    };
    return { mm, painted };
}

const ramp = (min, max, lo = '#eee', hi = '#333') =>
    ['interpolate', ['linear'], ['get', 'v'], min, lo, max, hi];

function vectorState(overrides = {}) {
    return {
        layerId: 'A', mapLayerId: 'layer-A', displayName: 'Parcels',
        visible: true, type: 'vector', group: null,
        legendType: 'continuous', legendLabel: null, legendClasses: null,
        legendRange: null, legendGradient: null,
        defaultPaint: { 'fill-color': ramp(0, 100), 'fill-opacity': 0.7 },
        ...overrides,
    };
}

function hexState(overrides = {}) {
    return {
        layerId: 'hex-abc', mapLayerId: 'hex-abc', displayName: 'Population',
        visible: true, type: 'vector', group: null, valueColumn: 'population',
        legendType: 'hex', legendLabel: null, legendClasses: null,
        hexValueStats: { by_res: { '5': { min: 0, max: 100 }, '6': { min: 0, max: 700 } } },
        hexPalette: 'viridis', hexCurrentRes: null,
        defaultPaint: {
            'fill-color': ['case', ['==', ['get', 'population'], null], 'rgba(0,0,0,0)',
                ['match', ['get', 'res'], 5, ramp(0, 100), 6, ramp(0, 700), 'rgba(0,0,0,0)']],
            'fill-opacity': 0.8,
        },
        ...overrides,
    };
}

const labels = (mm, id) =>
    [...mm._legendItems.get(id).querySelectorAll('.legend-labels span')].map(s => s.textContent);
const bar = (mm, id) =>
    mm._legendItems.get(id).querySelector('.legend-colorbar').style.background;
const resNote = (mm, id) =>
    mm._legendItems.get(id).querySelector('.legend-hex-res').textContent;
/**
 * Swatch rows as [label, color] pairs, in render order. jsdom normalizes an
 * inline hex background to `rgb(r, g, b)`, so fold it back to 6-digit hex to
 * keep expectations readable.
 */
const swatches = (mm, id) =>
    [...mm._legendItems.get(id).querySelectorAll('.legend-item')].map((row) => {
        const bg = row.querySelector('span').style.background;
        const m = bg.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
        const hex = m
            ? '#' + m.slice(1).map(n => Number(n).toString(16).padStart(2, '0')).join('')
            : bg;
        return [row.textContent, hex];
    });

describe('legend follows set_style — continuous vector (#333)', () => {
    it('relabels the colorbar to the new ramp instead of keeping the registered one', () => {
        const state = vectorState();
        const { mm } = createManager([state]);
        mm._showLegendIfVisible('A');
        expect(labels(mm, 'A')).toEqual(['0', '100']);

        mm.setStyle('A', { 'fill-color': ramp(0, 500, '#f7fbff', '#08306b') });

        expect(labels(mm, 'A')).toEqual(['0', '500']);
        expect(bar(mm, 'A')).toBe('linear-gradient(to right, #f7fbff, #08306b)');
    });

    it('derived values win over config legend_gradient / legend_range once restyled', () => {
        const state = vectorState({
            defaultPaint: { 'fill-color': '#2E7D32' },
            legendGradient: ['#ffffff', '#000000'],
            legendRange: [0, 10],
        });
        const { mm } = createManager([state]);
        mm._showLegendIfVisible('A');
        expect(labels(mm, 'A')).toEqual(['0', '10']);

        mm.setStyle('A', { 'fill-color': ramp(0, 900) });

        expect(labels(mm, 'A')).toEqual(['0', '900']);
    });

    it('drops the legend when restyled to a flat color it can no longer describe', () => {
        const state = vectorState();
        const { mm } = createManager([state]);
        mm._showLegendIfVisible('A');
        const item = mm._legendItems.get('A');

        mm.setStyle('A', { 'fill-color': '#ff0000' });

        expect(mm._legendItems.has('A')).toBe(false);
        expect(item.parentNode).toBeNull();          // removed, not just hidden
        expect(mm._legendEl.style.display).toBe('none');
    });

    it('leaves the legend alone for an opacity-only restyle', () => {
        const state = vectorState();
        const { mm } = createManager([state]);
        mm._showLegendIfVisible('A');

        mm.setStyle('A', { 'fill-opacity': 0.2 });

        expect(labels(mm, 'A')).toEqual(['0', '100']);
    });
});

describe('legend appears for an agent-built choropleth (#333)', () => {
    it('promotes a legend-less vector layer to a continuous legend', () => {
        const state = vectorState({ legendType: null, defaultPaint: { 'fill-color': '#2E7D32' } });
        const { mm } = createManager([state]);
        mm._showLegendIfVisible('A');
        expect(mm._legendItems.size).toBe(0);

        mm.setStyle('A', { 'fill-color': ramp(5, 42) });

        expect(state.legendType).toBe('continuous');
        expect(state.legendTypeAuto).toBe(true);
        expect(labels(mm, 'A')).toEqual(['5', '42']);
    });

    it('demotes again when a later restyle is no longer describable', () => {
        const state = vectorState({ legendType: null, defaultPaint: { 'fill-color': '#2E7D32' } });
        const { mm } = createManager([state]);
        mm.setStyle('A', { 'fill-color': ramp(5, 42) });
        mm.setStyle('A', { 'fill-color': '#ff0000' });

        expect(state.legendType).toBeNull();
        expect(state.legendTypeAuto).toBe(false);
        expect(mm._legendItems.has('A')).toBe(false);
    });

    it('switches a continuous legend to swatches when restyled categorically', () => {
        const state = vectorState({ legendType: null, defaultPaint: { 'fill-color': '#2E7D32' } });
        const { mm } = createManager([state]);
        mm.setStyle('A', { 'fill-color': ramp(5, 42) });
        expect(state.legendType).toBe('continuous');

        mm.setStyle('A', { 'fill-color': ['match', ['get', 'gap'], '1', '#cc1111', '#999999'] });

        expect(state.legendType).toBe('categorical');
        expect(state.legendTypeAuto).toBe(true);
        expect(swatches(mm, 'A')).toEqual([['1', '#cc1111']]);
    });

    it('does not promote a raster layer', () => {
        const state = vectorState({ type: 'raster', legendType: null });
        const { mm } = createManager([state]);
        mm.setStyle('A', { 'raster-opacity': 0.4 });
        expect(state.legendType).toBeNull();
    });

    it('leaves a config-declared legend type untouched', () => {
        const state = vectorState({ legendType: 'categorical', legendClasses: [{ name: 'a', 'color-hint': '#123456' }, { name: 'b', 'color-hint': '#654321' }] });
        const { mm } = createManager([state]);
        mm.setStyle('A', { 'fill-color': ramp(0, 9) });

        expect(state.legendType).toBe('categorical');
        expect(state.legendTypeAuto).toBeUndefined();
    });
});

describe('resetStyle returns the legend to its boot state (#333)', () => {
    it('removes a legend that only a restyle created', () => {
        const state = vectorState({ legendType: null, defaultPaint: { 'fill-color': '#2E7D32' } });
        const { mm, painted } = createManager([state]);
        mm.setStyle('A', { 'fill-color': ramp(5, 42) });
        expect(mm._legendItems.has('A')).toBe(true);

        mm.resetStyle('A');

        expect(state.legendType).toBeNull();
        expect(state.legendTypeAuto).toBe(false);
        expect(state.currentPaint).toBeNull();
        expect(mm._legendItems.has('A')).toBe(false);
        expect(painted['layer-A:fill-color']).toBe('#2E7D32');
    });

    it('restores the registered ramp on a config-declared legend', () => {
        const state = vectorState();
        const { mm } = createManager([state]);
        mm._showLegendIfVisible('A');
        mm.setStyle('A', { 'fill-color': ramp(0, 500) });
        expect(labels(mm, 'A')).toEqual(['0', '500']);

        mm.resetStyle('A');

        expect(labels(mm, 'A')).toEqual(['0', '100']);
    });
});

describe('legend follows set_style — hex layers (#333)', () => {
    it('keeps the per-res palette legend for an opacity-only restyle', () => {
        const state = hexState();
        const { mm } = createManager([state]);
        mm._showLegendIfVisible('hex-abc');
        expect(labels(mm, 'hex-abc')).toEqual(['0', '700']);

        mm.setStyle('hex-abc', { 'fill-opacity': 0.4 });

        expect(labels(mm, 'hex-abc')).toEqual(['0', '700']);
        expect(bar(mm, 'hex-abc')).toBe(`linear-gradient(to right, ${PALETTES.viridis.join(', ')})`);
    });

    it('mirrors a fixed ramp that replaced the per-res expression', () => {
        const state = hexState();
        const { mm } = createManager([state]);
        mm._showLegendIfVisible('hex-abc');

        mm.setStyle('hex-abc', {
            'fill-color': ['interpolate', ['linear'], ['get', 'population'], 0, '#ffffcc', 1200, '#800026'],
        });

        expect(labels(mm, 'hex-abc')).toEqual(['0', '1,200']);
        expect(bar(mm, 'hex-abc')).toBe('linear-gradient(to right, #ffffcc, #800026)');
        expect(resNote(mm, 'hex-abc')).toBe('H3 resolution 6');
    });

    it('omits the resolution note when a restyled layer has no per-res stats', () => {
        const state = hexState({ hexValueStats: { by_res: {} } });
        const { mm } = createManager([state]);

        mm.setStyle('hex-abc', {
            'fill-color': ['interpolate', ['linear'], ['get', 'population'], 1, '#000000', 8, '#ffffff'],
        });

        expect(labels(mm, 'hex-abc')).toEqual(['1', '8']);
        expect(resNote(mm, 'hex-abc')).toBe('');
    });

    it('replaces the colorbar with swatches when recolored categorically', () => {
        const state = hexState();
        const { mm } = createManager([state]);
        mm._showLegendIfVisible('hex-abc');
        expect(labels(mm, 'hex-abc')).toEqual(['0', '700']);

        mm.setStyle('hex-abc', {
            'fill-color': ['match', ['get', 'population'], 1, '#111111', 2, '#222222', '#999999'],
        });

        // Swatches, not a colorbar: no gradient bar and no zoom-reactive refs,
        // since a `match` has no per-resolution value domain to relabel (#334).
        expect(swatches(mm, 'hex-abc')).toEqual([['1', '#111111'], ['2', '#222222']]);
        expect(mm._legendItems.get('hex-abc').querySelector('.legend-colorbar')).toBeNull();
        expect(mm._hexLegendRefs.has('hex-abc')).toBe(false);
        // The declared type is untouched, so resetStyle still restores the colorbar.
        expect(state.legendType).toBe('hex');
    });

    it('resetStyle restores the per-res colorbar after a categorical restyle', () => {
        const state = hexState();
        const { mm } = createManager([state]);
        mm._showLegendIfVisible('hex-abc');
        mm.setStyle('hex-abc', {
            'fill-color': ['match', ['get', 'population'], 1, '#111111', '#999999'],
        });

        mm.resetStyle('hex-abc');

        expect(labels(mm, 'hex-abc')).toEqual(['0', '700']);
        expect(resNote(mm, 'hex-abc')).toBe('H3 resolution 6');
    });

    it('still drops the legend when recolored past anything describable', () => {
        const state = hexState();
        const { mm } = createManager([state]);
        mm._showLegendIfVisible('hex-abc');

        mm.setStyle('hex-abc', { 'fill-color': '#888888' });

        expect(mm._legendItems.has('hex-abc')).toBe(false);
        expect(mm._hexLegendRefs.has('hex-abc')).toBe(false);
    });
});

describe('categorical legends follow set_style (#334)', () => {
    it('drops stale config classes when recolored to a ramp it cannot describe', () => {
        const state = vectorState({
            legendType: 'categorical',
            legendClasses: [{ name: 'GAP 1', 'color-hint': '#123456' }],
            defaultPaint: { 'fill-color': ['match', ['get', 'gap'], '1', '#123456', '#999'] },
        });
        const { mm } = createManager([state]);
        mm._showLegendIfVisible('A');
        expect(swatches(mm, 'A')).toEqual([['GAP 1', '#123456']]);

        mm.setStyle('A', { 'fill-color': '#ff0000' });

        expect(mm._legendItems.has('A')).toBe(false);
    });

    it('shows the new classes, not the config ones, after a categorical restyle', () => {
        const state = vectorState({
            legendType: 'categorical',
            legendClasses: [{ name: 'GAP 1', 'color-hint': '#123456' }],
            defaultPaint: { 'fill-color': ['match', ['get', 'gap'], '1', '#123456', '#999'] },
        });
        const { mm } = createManager([state]);
        mm._showLegendIfVisible('A');

        mm.setStyle('A', { 'fill-color': ['match', ['get', 'taxon'], 3, '#2ca02c', 4, '#9467bd', '#ccc'] });

        expect(swatches(mm, 'A')).toEqual([['3', '#2ca02c'], ['4', '#9467bd']]);
    });

    it('keeps the per-layer heading on a single derived class', () => {
        // #328 drops the heading for a lone *config* class whose name restates
        // the display name; a bare derived value restates nothing.
        const state = vectorState({ legendType: null, defaultPaint: { 'fill-color': '#2E7D32' } });
        const { mm } = createManager([state]);

        mm.setStyle('A', { 'fill-color': ['match', ['get', 'gap'], 1, '#111111', '#999999'] });

        expect(mm._legendItems.get('A').querySelector('h4').textContent).toBe('Parcels');
    });

    it('groups multi-value match arms into one swatch', () => {
        const state = vectorState({ legendType: null, defaultPaint: { 'fill-color': '#2E7D32' } });
        const { mm } = createManager([state]);

        mm.setStyle('A', { 'fill-color': ['match', ['get', 'gap'], [1, 2], '#111', [3, 4], '#222', '#999'] });

        expect(swatches(mm, 'A')).toEqual([['1, 2', '#111111'], ['3, 4', '#222222']]);
    });

    it('leaves an opacity-only restyle on a categorical layer alone', () => {
        const state = vectorState({
            legendType: 'categorical',
            legendClasses: [{ name: 'GAP 1', 'color-hint': '#123456' }, { name: 'GAP 2', 'color-hint': '#654321' }],
        });
        const { mm } = createManager([state]);
        mm._showLegendIfVisible('A');

        mm.setStyle('A', { 'fill-opacity': 0.3 });

        expect(swatches(mm, 'A')).toEqual([['GAP 1', '#123456'], ['GAP 2', '#654321']]);
    });
});

describe('legend refresh housekeeping (#333)', () => {
    it('hides a group wrapper once its last member loses its legend', () => {
        const state = vectorState({ group: 'Monuments' });
        const { mm } = createManager([state]);
        mm._showLegendIfVisible('A');
        const wrapper = mm._legendGroups.get('Monuments');
        expect(wrapper.querySelectorAll('.legend-section')).toHaveLength(1);

        mm.setStyle('A', { 'fill-color': '#ff0000' });

        expect(wrapper.querySelectorAll('.legend-section')).toHaveLength(0);
        expect(wrapper.style.display).toBe('none');
    });

    it('a hidden layer restyled then shown renders the new ramp', () => {
        const state = vectorState({ visible: false });
        const { mm } = createManager([state]);
        mm._showLegendIfVisible('A');
        expect(mm._legendItems.size).toBe(0);

        mm.setStyle('A', { 'fill-color': ramp(0, 250) });
        state.visible = true;
        mm._showLegendIfVisible('A');

        expect(labels(mm, 'A')).toEqual(['0', '250']);
    });

    it('switchVersion discards a restyle-derived legend and the stale section', () => {
        const state = vectorState({
            legendType: null,
            defaultPaint: { 'fill-color': '#2E7D32' },
            versions: [
                { label: 'L3', mapLayerId: 'v0', outlineLayerId: null, sourceId: 's0', sourceLayer: null },
                { label: 'L4', mapLayerId: 'v1', outlineLayerId: null, sourceId: 's1', sourceLayer: null },
            ],
            activeVersionIndex: 0,
            filter: null,
        });
        const { mm } = createManager([state]);
        mm.setStyle('A', { 'fill-color': ramp(0, 42) });
        const item = mm._legendItems.get('A');
        expect(item).toBeTruthy();

        mm.switchVersion('A', 1);

        expect(state.currentPaint).toBeNull();
        expect(state.legendType).toBeNull();
        expect(mm._legendItems.has('A')).toBe(false);
        expect(item.parentNode).toBeNull();
    });
});
