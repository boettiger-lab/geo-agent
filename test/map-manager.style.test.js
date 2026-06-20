import { describe, it, expect, beforeEach } from 'vitest';
import { MapManager } from '../app/map-manager.js';

/**
 * Bare MapManager mock — exposes only the surface setStyle touches.
 * The setPaintProperty stub fails for any property that doesn't start with
 * the recorded layer type, mirroring MapLibre's behaviour where e.g.
 * `stroke-color` on a fill layer throws.
 */
function createManager(layerType = 'fill') {
    const sources = new Map();
    const layers = new Map([[ 'layer-A', { id: 'layer-A', type: layerType } ]]);
    const map = {
        addSource: (id, s) => sources.set(id, s),
        getSource: (id) => sources.get(id) || null,
        addLayer: (l) => layers.set(l.id, l),
        getLayer: (id) => layers.get(id) || null,
        setPaintProperty(id, prop) {
            const t = layers.get(id)?.type;
            if (!t || !prop.startsWith(`${t}-`)) {
                throw new Error(`layer "${id}" doesn't support "${prop}"`);
            }
        },
        on() {}, off() {},
    };
    const mm = Object.create(MapManager.prototype);
    mm.map = map;
    mm.layers = new Map([[
        'A',
        { mapLayerId: 'layer-A', displayName: 'A', defaultPaint: {} },
    ]]);
    return mm;
}

describe('MapManager.setStyle', () => {
    let mm;
    beforeEach(() => { mm = createManager('fill'); });

    it('returns success=true when every property applies', () => {
        const r = mm.setStyle('A', { 'fill-color': 'red', 'fill-opacity': 0.5 });
        expect(r.success).toBe(true);
        expect(r.updates).toHaveLength(2);
        expect(r.updates.every(u => u.success)).toBe(true);
        expect(r.error).toBeUndefined();
    });

    it('returns success=false when any property fails and names the offenders', () => {
        const r = mm.setStyle('A', { 'fill-color': 'red', 'stroke-color': 'blue', 'stroke-width': 2 });
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/stroke-color.*stroke-width/);
        expect(r.error).toMatch(/Layer type is "fill"/);
        expect(r.updates.find(u => u.property === 'fill-color').success).toBe(true);
        expect(r.updates.find(u => u.property === 'stroke-color').success).toBe(false);
    });

    it('returns success=false with an unknown-layer error when the id is missing', () => {
        const r = mm.setStyle('missing', { 'fill-color': 'red' });
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/Unknown layer/);
    });
});

describe('MapManager.setStyle — hex value-column rewrite (#259)', () => {
    function createHexManager(valueColumn) {
        const applied = {};
        const map = {
            getLayer: () => ({ id: 'hex-layer', type: 'fill' }),
            setPaintProperty(id, prop, value) { applied[prop] = value; },
        };
        const mm = Object.create(MapManager.prototype);
        mm.map = map;
        mm.layers = new Map([[
            'hex-abc',
            { mapLayerId: 'hex-layer', displayName: 'Richness', valueColumn },
        ]]);
        return { mm, applied };
    }

    it('repoints a guessed ["get","count"] to the layer value column and applies the corrected paint', () => {
        const { mm, applied } = createHexManager('species_richness');
        const r = mm.setStyle('hex-abc', {
            'fill-color': ['interpolate', ['log'], ['get', 'count'], 1, '#440154', 125, '#FDE725'],
            'fill-opacity': 0.7,
        });
        expect(r.success).toBe(true);
        expect(applied['fill-color']).toEqual(
            ['interpolate', ['log'], ['get', 'species_richness'], 1, '#440154', 125, '#FDE725']);
        expect(r.note).toMatch(/"count".*"species_richness"/);
    });

    it('leaves an already-correct expression unchanged and emits no note', () => {
        const { mm, applied } = createHexManager('species_richness');
        const r = mm.setStyle('hex-abc', {
            'fill-color': ['interpolate', ['linear'], ['get', 'species_richness'], 0, '#000', 10, '#fff'],
        });
        expect(r.success).toBe(true);
        expect(applied['fill-color']).toEqual(
            ['interpolate', ['linear'], ['get', 'species_richness'], 0, '#000', 10, '#fff']);
        expect(r.note).toBeUndefined();
    });

    it('does not rewrite for non-hex layers (no valueColumn in state)', () => {
        const { mm, applied } = createHexManager(undefined);
        const r = mm.setStyle('hex-abc', {
            'fill-color': ['interpolate', ['linear'], ['get', 'count'], 0, '#000', 10, '#fff'],
        });
        expect(r.success).toBe(true);
        expect(applied['fill-color']).toEqual(
            ['interpolate', ['linear'], ['get', 'count'], 0, '#000', 10, '#fff']);
        expect(r.note).toBeUndefined();
    });
});
