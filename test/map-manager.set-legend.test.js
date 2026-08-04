// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { MapManager } from '../app/map-manager.js';

/**
 * The legend mirrors the map's colors on its own (#333, #334), but nothing on
 * the client knows what an agent-invented code *means* — that lives in the SQL
 * that produced the layer. `set_legend` supplies exactly that missing half, and
 * nothing that would let the legend disagree with the paint (#334).
 */

function createManager(states) {
    const mm = Object.create(MapManager.prototype);
    mm.layers = new Map(states.map(s => [s.layerId, s]));
    mm._legendItems = new Map();
    mm._legendGroups = new Map();
    mm._hexLegendRefs = new Map();
    mm._hexLegendReactive = true;
    mm._legendEl = null;
    mm._legendContent = null;
    mm._ensureLegend = function () {
        if (this._legendEl) return;
        this._legendEl = document.createElement('div');
        this._legendContent = document.createElement('div');
        this._legendEl.appendChild(this._legendContent);
        document.body.appendChild(this._legendEl);
    };
    mm._getColormapGradient = async () => 'linear-gradient(to right, #eee, #333)';
    mm.map = {
        on: () => {},
        setPaintProperty: () => {},
        getLayer: () => ({ type: 'fill' }),
        queryRenderedFeatures: () => [{ properties: { res: 6 } }],
    };
    return mm;
}

const taxonPaint = {
    'fill-color': ['match', ['get', 'dominant_taxon'],
        1, '#1f77b4', 2, '#ff7f0e', 3, '#2ca02c', '#cccccc'],
};

/** A hex layer already recolored categorically — the #334 session's end state. */
function recoloredHex(overrides = {}) {
    return {
        layerId: 'hex-abc', mapLayerId: 'hex-abc', displayName: 'Hex: dominant_taxon',
        visible: true, type: 'vector', group: null, valueColumn: 'dominant_taxon',
        legendType: 'hex', legendLabel: null, legendClasses: null,
        hexValueStats: { by_res: { '7': { min: 1, max: 5 } } },
        hexPalette: 'viridis', hexCurrentRes: null,
        defaultPaint: { 'fill-color': ['interpolate', ['linear'], ['get', 'dominant_taxon'], 1, '#440154', 5, '#fde725'] },
        currentPaint: taxonPaint,
        ...overrides,
    };
}

const rows = (mm, id) =>
    [...mm._legendItems.get(id).querySelectorAll('.legend-item')].map(r => r.textContent);

describe('setLegend labels (#334)', () => {
    it('names the swatches of a categorically recolored hex layer', () => {
        const mm = createManager([recoloredHex()]);
        mm._showLegendIfVisible('hex-abc');
        expect(rows(mm, 'hex-abc')).toEqual(['1', '2', '3']);

        const result = mm.setLegend('hex-abc', {
            labels: { 1: 'Amphibians', 2: 'Reptiles', 3: 'Birds' },
        });

        expect(result.success).toBe(true);
        expect(rows(mm, 'hex-abc')).toEqual(['Amphibians', 'Reptiles', 'Birds']);
    });

    it('matches labels keyed as strings against numeric match values', () => {
        // Tool args arrive as JSON, so a model naming integer codes sends string keys.
        const mm = createManager([recoloredHex()]);
        mm.setLegend('hex-abc', { labels: { '2': 'Reptiles' } });
        expect(rows(mm, 'hex-abc')).toEqual(['1', 'Reptiles', '3']);
    });

    it('merges across calls instead of replacing', () => {
        const mm = createManager([recoloredHex()]);
        mm.setLegend('hex-abc', { labels: { 1: 'Amphibians' } });
        mm.setLegend('hex-abc', { labels: { 3: 'Birds' } });
        expect(rows(mm, 'hex-abc')).toEqual(['Amphibians', '2', 'Birds']);
    });

    it('leaves unlabelled classes showing their bare value', () => {
        const mm = createManager([recoloredHex()]);
        mm.setLegend('hex-abc', { labels: { 1: 'Amphibians' } });
        expect(rows(mm, 'hex-abc')).toEqual(['Amphibians', '2', '3']);
    });

    it('labels a multi-value match arm by its joined key', () => {
        const mm = createManager([recoloredHex({
            currentPaint: { 'fill-color': ['match', ['get', 'g'], [1, 2], '#111111', 3, '#222222', '#ccc'] },
        })]);
        mm.setLegend('hex-abc', { labels: { '1,2': 'Vertebrates' } });
        expect(rows(mm, 'hex-abc')).toEqual(['Vertebrates', '3']);
    });

    it('overrides config legend_classes names too', () => {
        const mm = createManager([{
            layerId: 'A', mapLayerId: 'layer-A', displayName: 'Conserved', visible: true,
            type: 'vector', group: null, legendType: 'categorical',
            legendClasses: [{ value: 1, name: 'GAP 1', 'color-hint': '#123456' }],
            defaultPaint: { 'fill-color': '#123456' },
        }]);
        mm.setLegend('A', { labels: { 1: 'Strictly protected' } });
        expect(rows(mm, 'A')).toEqual(['Strictly protected']);
    });

    it('rejects a non-object labels argument', () => {
        const mm = createManager([recoloredHex()]);
        expect(mm.setLegend('hex-abc', { labels: ['Amphibians'] }).success).toBe(false);
        expect(mm.setLegend('hex-abc', { labels: { 1: 5 } }).error).toMatch(/must be a string/);
    });

    it('errors on an unknown layer', () => {
        const mm = createManager([recoloredHex()]);
        expect(mm.setLegend('nope', { labels: {} })).toEqual({
            success: false, error: 'Unknown layer: nope',
        });
    });
});

describe('setLegend title / units / visibility (#334)', () => {
    it('retitles the legend heading and the layer panel row', () => {
        const mm = createManager([recoloredHex()]);
        const row = document.createElement('div');
        row.id = 'layer-item-hex-abc';
        const label = document.createElement('label');
        const span = document.createElement('span');
        span.textContent = 'Hex: dominant_taxon';
        label.appendChild(span);
        row.appendChild(label);
        document.body.appendChild(row);

        mm.setLegend('hex-abc', { title: 'Dominant taxon (unprotected)' });
        mm._showLegendIfVisible('hex-abc');

        expect(mm._legendItems.get('hex-abc').querySelector('h4').textContent)
            .toBe('Dominant taxon (unprotected)');
        expect(span.textContent).toBe('Dominant taxon (unprotected)');
        row.remove();
    });

    it('adds units to a colorbar\'s end values', () => {
        const mm = createManager([{
            layerId: 'A', mapLayerId: 'layer-A', displayName: 'Richness', visible: true,
            type: 'vector', group: null, legendType: 'continuous', legendLabel: null,
            legendClasses: null, legendRange: null, legendGradient: null,
            defaultPaint: { 'fill-color': ['interpolate', ['linear'], ['get', 'v'], 0, '#eee', 42, '#333'] },
        }]);
        mm.setLegend('A', { units: 'species' });
        mm._showLegendIfVisible('A');

        const labels = [...mm._legendItems.get('A').querySelectorAll('.legend-labels span')]
            .map(s => s.textContent);
        expect(labels).toEqual(['0 species', '42 species']);
    });

    it('hides and restores a layer\'s legend section', () => {
        const mm = createManager([recoloredHex()]);
        mm._showLegendIfVisible('hex-abc');
        expect(mm._legendItems.has('hex-abc')).toBe(true);

        mm.setLegend('hex-abc', { visible: false });
        expect(mm._legendItems.has('hex-abc')).toBe(false);

        mm.setLegend('hex-abc', { visible: true });
        expect(rows(mm, 'hex-abc')).toEqual(['1', '2', '3']);
    });

    it('validates title and visible', () => {
        const mm = createManager([recoloredHex()]);
        expect(mm.setLegend('hex-abc', { title: '  ' }).error).toMatch(/non-empty/);
        expect(mm.setLegend('hex-abc', { visible: 'yes' }).error).toMatch(/boolean/);
    });
});

describe('resetLegend (#334)', () => {
    it('restores boot labels, title, units, and visibility', () => {
        const mm = createManager([recoloredHex({ legendLabel: 'cells' })]);
        mm.setLegend('hex-abc', {
            labels: { 1: 'Amphibians' }, title: 'Renamed', units: 'taxa', visible: false,
        });

        const result = mm.resetLegend('hex-abc');

        expect(result.success).toBe(true);
        expect(mm.layers.get('hex-abc').displayName).toBe('Hex: dominant_taxon');
        expect(mm.layers.get('hex-abc').legendLabel).toBe('cells');
        expect(mm.layers.get('hex-abc').legendHidden).toBe(false);
        expect(rows(mm, 'hex-abc')).toEqual(['1', '2', '3']);
    });

    it('leaves a restyle-derived legend derived — it is not a style reset', () => {
        const mm = createManager([recoloredHex()]);
        mm.setLegend('hex-abc', { labels: { 1: 'Amphibians' } });

        mm.resetLegend('hex-abc');

        // Still swatches from the current `match`, not the registered colorbar.
        expect(mm.layers.get('hex-abc').currentPaint).toBe(taxonPaint);
        expect(rows(mm, 'hex-abc')).toEqual(['1', '2', '3']);
    });

    it('errors on an unknown layer', () => {
        const mm = createManager([recoloredHex()]);
        expect(mm.resetLegend('nope').success).toBe(false);
    });
});

describe('legend state in getMapState (#334)', () => {
    it('reports the resolved type, not the declared one', () => {
        // The layer is declared `hex` but recolored categorically: reporting
        // 'hex' is what let the agent read a legend complaint as a paint bug.
        const mm = createManager([recoloredHex()]);
        const { layers } = mm.getMapState();
        expect(layers['hex-abc'].legend.type).toBe('categorical');
        expect(layers['hex-abc'].legend.rendered).toBe(true);
    });

    it('lists class values with the label each currently shows', () => {
        const mm = createManager([recoloredHex()]);
        mm.setLegend('hex-abc', { labels: { 2: 'Reptiles' } });

        expect(mm.getMapState().layers['hex-abc'].legend.classes).toEqual([
            { value: 1, label: '1' },
            { value: 2, label: 'Reptiles' },
            { value: 3, label: '3' },
        ]);
    });

    it('reports units and suppression', () => {
        const mm = createManager([recoloredHex()]);
        mm.setLegend('hex-abc', { units: 'cells', visible: false });
        const { legend } = mm.getMapState().layers['hex-abc'];
        expect(legend.units).toBe('cells');
        expect(legend.rendered).toBe(false);
    });

    it('reports a null type for a layer with no legend', () => {
        const mm = createManager([{
            layerId: 'A', mapLayerId: 'layer-A', displayName: 'Plain', visible: true,
            type: 'vector', group: null, legendType: null, legendClasses: null,
            defaultPaint: { 'fill-color': '#2E7D32' },
        }]);
        const { legend } = mm.getMapState().layers.A;
        expect(legend.type).toBeNull();
        expect(legend.rendered).toBe(false);
    });
});
