// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { MapManager } from '../app/map-manager.js';

/**
 * Uploaded GeoJSON layers (geo-agent#325) are added at runtime like hex layers:
 * an inline `geojson` source + fill + outline, a panel row with a remove button,
 * and a guarded teardown. These pin that behavior with a minimal map stub.
 */

function createManager(layers = []) {
    const calls = { addSource: [], addLayer: [], removeLayer: [], removeSource: [], fitBounds: [] };
    // MapLibre namespaces layers and sources separately (a source and a layer
    // may share an id, as they do here), so track them apart.
    const layersPresent = new Set();
    const sourcesPresent = new Set();
    const mm = Object.create(MapManager.prototype);
    mm.layers = new Map(layers);
    mm._controlsContainerEl = document.createElement('div');
    mm._refreshCycleBtnState = () => {};
    mm._tooltip = document.createElement('div');
    mm.map = {
        addSource: (id, s) => { calls.addSource.push({ id, s }); sourcesPresent.add(id); },
        addLayer: (def) => { calls.addLayer.push(def); layersPresent.add(def.id); },
        removeLayer: (id) => { calls.removeLayer.push(id); layersPresent.delete(id); },
        removeSource: (id) => { calls.removeSource.push(id); sourcesPresent.delete(id); },
        getLayer: (id) => (layersPresent.has(id) ? { id } : undefined),
        getSource: (id) => (sourcesPresent.has(id) ? { id } : undefined),
        fitBounds: (b, o) => calls.fitBounds.push({ b, o }),
        on: () => {},
    };
    return { mm, calls };
}

const FC = {
    type: 'FeatureCollection',
    features: [{
        type: 'Feature', properties: { name: 'AOI' },
        geometry: { type: 'Polygon', coordinates: [[[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]] },
    }],
};

describe('MapManager.addUploadedLayer', () => {
    it('adds an inline geojson source, fill + outline, and a panel row', () => {
        const { mm, calls } = createManager();
        const r = mm.addUploadedLayer({ id: 'abc', geojson: FC, displayName: 'My AOI', bounds: [-1, -1, 1, 1] });

        expect(r.success).toBe(true);
        expect(r.layer_id).toBe('upload-abc');
        // inline data, not a URL
        expect(calls.addSource[0].s).toEqual({ type: 'geojson', data: FC });
        const ids = calls.addLayer.map(l => l.id);
        expect(ids).toEqual(['upload-abc', 'upload-abc-outline']);
        expect(calls.addLayer[0].type).toBe('fill');
        expect(calls.addLayer[1].type).toBe('line');
        expect(calls.fitBounds).toHaveLength(1);

        const state = mm.layers.get('upload-abc');
        expect(state.type).toBe('vector');
        expect(state.outlineLayerId).toBe('upload-abc-outline');
        expect(state.tooltipFields).toBeNull(); // not passed → default null
        const row = mm._controlsContainerEl.querySelector('#layer-item-upload-abc');
        expect(row).not.toBeNull();
        expect(row.querySelector('.layer-remove-btn')).not.toBeNull();
    });

    it('is idempotent by id', () => {
        const { mm, calls } = createManager();
        mm.addUploadedLayer({ id: 'abc', geojson: FC, displayName: 'A' });
        const again = mm.addUploadedLayer({ id: 'abc', geojson: FC, displayName: 'A' });
        expect(again.already_exists).toBe(true);
        expect(calls.addSource).toHaveLength(1);
    });

    it('validates required inputs', () => {
        const { mm } = createManager();
        expect(mm.addUploadedLayer({ geojson: FC, displayName: 'x' }).success).toBe(false);
        expect(mm.addUploadedLayer({ id: 'a', displayName: 'x' }).success).toBe(false);
    });
});

describe('MapManager.removeUploadedLayer', () => {
    it('tears down fill, outline, source, state, and panel row', () => {
        const { mm, calls } = createManager();
        mm.addUploadedLayer({ id: 'abc', geojson: FC, displayName: 'A' });
        const r = mm.removeUploadedLayer('upload-abc');

        expect(r.success).toBe(true);
        expect(calls.removeLayer).toEqual(['upload-abc-outline', 'upload-abc']);
        expect(calls.removeSource).toEqual(['upload-abc']);
        expect(mm.layers.has('upload-abc')).toBe(false);
        expect(mm._controlsContainerEl.querySelector('#layer-item-upload-abc')).toBeNull();
    });

    it('refuses non-upload ids so curated/hex layers are safe', () => {
        const { mm } = createManager([['hex-x', { displayName: 'h', visible: true }]]);
        expect(mm.removeUploadedLayer('hex-x').success).toBe(false);
        expect(mm.removeUploadedLayer('cpad/holdings').success).toBe(false);
    });

    it('clicking the row remove button removes the uploaded layer', () => {
        const { mm } = createManager();
        mm.addUploadedLayer({ id: 'abc', geojson: FC, displayName: 'A' });
        const row = mm._controlsContainerEl.querySelector('#layer-item-upload-abc');
        row.querySelector('.layer-remove-btn').click();
        expect(mm.layers.has('upload-abc')).toBe(false);
    });
});
