import { describe, it, expect, beforeEach } from 'vitest';
import { MapManager } from '../app/map-manager.js';

/**
 * Minimal MapLibre Map mock — records calls and exposes inspectable state.
 * Only implements the methods addHexTileLayer / removeHexTileLayer touch.
 */
function createMockMap() {
    const sources = new Map();
    const layers = new Map();
    const fitBoundsCalls = [];
    return {
        addSource(id, source) {
            if (sources.has(id)) throw new Error(`Source already exists: ${id}`);
            sources.set(id, source);
        },
        getSource(id) { return sources.get(id) || null; },
        removeSource(id) {
            if (!sources.has(id)) throw new Error(`No source: ${id}`);
            sources.delete(id);
        },
        addLayer(layer) {
            if (layers.has(layer.id)) throw new Error(`Layer already exists: ${layer.id}`);
            layers.set(layer.id, layer);
        },
        getLayer(id) { return layers.get(id) || null; },
        removeLayer(id) {
            if (!layers.has(id)) throw new Error(`No layer: ${id}`);
            layers.delete(id);
        },
        setLayoutProperty() {},
        setFilter() {},
        setPaintProperty() {},
        queryRenderedFeatures() { return []; },
        fitBounds(bounds, options) { fitBoundsCalls.push({ bounds, options }); },
        // Introspection helpers (not real MapLibre API)
        _sources: sources,
        _layers: layers,
        _fitBoundsCalls: fitBoundsCalls,
    };
}

/**
 * Build a MapManager with the mock map. MapManager's constructor may
 * call methods on the map — the mock ignores them gracefully.
 */
function createManager() {
    const mm = Object.create(MapManager.prototype);
    mm.map = createMockMap();
    mm.layers = new Map();
    // Stub legend helpers the mutators might call.
    mm._showRasterLegend = () => {};
    mm._hideRasterLegend = () => {};
    return mm;
}

describe('MapManager.addHexTileLayer', () => {
    let mm;
    beforeEach(() => { mm = createManager(); });

    it('registers a vector source and fill layer for a fresh URL', () => {
        const tileUrl = 'https://example.com/tiles/hex/abc123/{z}/{x}/{y}.pbf';
        const result = mm.addHexTileLayer({
            tileUrl,
            valueColumn: 'density',
            valueRange: [0, 1],
            bounds: [-125, 31, -102, 49],
            palette: 'viridis',
            opacity: 0.7,
            displayName: 'Density',
            fitBounds: false,
        });

        expect(result.success).toBe(true);
        expect(result.layer_id).toBe('hex-abc123');
        expect(result.already_exists).toBe(false);

        const src = mm.map._sources.get('hex-abc123');
        expect(src).toEqual({ type: 'vector', tiles: [tileUrl], minzoom: 0, maxzoom: 14 });

        const layer = mm.map._layers.get('hex-abc123');
        expect(layer.type).toBe('fill');
        expect(layer.source).toBe('hex-abc123');
        expect(layer['source-layer']).toBe('hex');
        expect(layer.paint['fill-opacity']).toBe(0.7);

        expect(mm.layers.get('hex-abc123')).toBeDefined();
        expect(mm.layers.get('hex-abc123').displayName).toBe('Density');
        expect(mm.layers.get('hex-abc123').type).toBe('vector');
        expect(mm.layers.get('hex-abc123').sourceLayer).toBe('hex');
    });

    it('calls fitBounds when fitBounds: true', () => {
        mm.addHexTileLayer({
            tileUrl: 'https://example.com/tiles/hex/xyz/{z}/{x}/{y}.pbf',
            valueColumn: 'v', valueRange: [0, 1],
            bounds: [-10, -20, 30, 40],
            palette: 'viridis', opacity: 0.7, displayName: 'X',
            fitBounds: true,
        });
        expect(mm.map._fitBoundsCalls).toHaveLength(1);
        expect(mm.map._fitBoundsCalls[0].bounds).toEqual([[-10, -20], [30, 40]]);
    });

    it('returns error for invalid tileUrl', () => {
        const result = mm.addHexTileLayer({
            tileUrl: 'https://example.com/not-a-hex-url',
            valueColumn: 'v', valueRange: [0, 1],
            bounds: [0, 0, 1, 1], palette: 'viridis',
            opacity: 0.7, displayName: 'X', fitBounds: false,
        });
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/Invalid tile_url/);
    });

    it('is idempotent by hash — second call with same URL returns already_exists', () => {
        const opts = {
            tileUrl: 'https://example.com/tiles/hex/samehash/{z}/{x}/{y}.pbf',
            valueColumn: 'v', valueRange: [0, 1],
            bounds: [0, 0, 1, 1], palette: 'viridis',
            opacity: 0.7, displayName: 'First', fitBounds: false,
        };
        const r1 = mm.addHexTileLayer(opts);
        expect(r1.already_exists).toBe(false);

        const r2 = mm.addHexTileLayer({ ...opts, displayName: 'Second' });
        expect(r2.success).toBe(true);
        expect(r2.already_exists).toBe(true);
        expect(r2.layer_id).toBe(r1.layer_id);
        // The idempotent return uses the originally-registered displayName, not the new one.
        // (This locks down the current contract — registry is not mutated on re-add.)
        expect(r2.display_name).toBe('First');

        // No duplicate source or layer — mock would throw on duplicate add
        expect(mm.map._sources.size).toBe(1);
        expect(mm.map._layers.size).toBe(1);
        // Display name unchanged from first call
        expect(mm.layers.get(r1.layer_id).displayName).toBe('First');
    });
});
