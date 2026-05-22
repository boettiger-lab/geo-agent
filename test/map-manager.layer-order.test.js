import { describe, it, expect } from 'vitest';
import { MapManager } from '../app/map-manager.js';

/**
 * Bare MapManager mock — just enough surface for the layer-order methods.
 * `styleLayers` is the simulated MapLibre layer stack in bottom-to-top order.
 */
function createManager(styleLayers, logicalLayers) {
    const stack = [...styleLayers]; // array of {id}
    const map = {
        getStyle: () => ({ layers: stack.map(l => ({ ...l })) }),
        moveLayer: (id, beforeId) => {
            const fromIdx = stack.findIndex(l => l.id === id);
            if (fromIdx === -1) throw new Error(`Unknown MapLibre layer: ${id}`);
            const [layer] = stack.splice(fromIdx, 1);
            if (beforeId === undefined) {
                stack.push(layer);
            } else {
                const toIdx = stack.findIndex(l => l.id === beforeId);
                if (toIdx === -1) throw new Error(`Unknown beforeId: ${beforeId}`);
                stack.splice(toIdx, 0, layer);
            }
        },
        _stack: () => stack.map(l => l.id),
    };
    const mm = Object.create(MapManager.prototype);
    mm.map = map;
    mm.layers = new Map(Object.entries(logicalLayers));
    return mm;
}

describe('MapManager._mapSublayersFor', () => {
    it('returns [mapLayerId] for a layer with no outline', () => {
        const mm = createManager(
            [{ id: 'layer-A' }],
            { A: { mapLayerId: 'layer-A', outlineLayerId: null } },
        );
        expect(mm._mapSublayersFor('A')).toEqual(['layer-A']);
    });

    it('returns [mapLayerId, outlineLayerId] in bottom-to-top order for a fill+outline', () => {
        const mm = createManager(
            [{ id: 'layer-A' }, { id: 'layer-A-outline' }],
            { A: { mapLayerId: 'layer-A', outlineLayerId: 'layer-A-outline' } },
        );
        expect(mm._mapSublayersFor('A')).toEqual(['layer-A', 'layer-A-outline']);
    });

    it('flattens all version sublayers for a versioned layer in bottom-to-top order', () => {
        const mm = createManager([], {
            V: {
                mapLayerId: 'layer-V--v-0',
                outlineLayerId: 'layer-V--v-0-outline',
                versions: [
                    { mapLayerId: 'layer-V--v-0', outlineLayerId: 'layer-V--v-0-outline' },
                    { mapLayerId: 'layer-V--v-1', outlineLayerId: 'layer-V--v-1-outline' },
                ],
            },
        });
        expect(mm._mapSublayersFor('V')).toEqual([
            'layer-V--v-0', 'layer-V--v-0-outline',
            'layer-V--v-1', 'layer-V--v-1-outline',
        ]);
    });

    it('returns [] for an unknown layerId', () => {
        const mm = createManager([], {});
        expect(mm._mapSublayersFor('missing')).toEqual([]);
    });
});

describe('MapManager.moveLayerToTop', () => {
    it('moves a single-sublayer layer to the top', () => {
        const mm = createManager(
            [{ id: 'layer-A' }, { id: 'layer-B' }, { id: 'layer-C' }],
            {
                A: { mapLayerId: 'layer-A', outlineLayerId: null, displayName: 'A' },
                B: { mapLayerId: 'layer-B', outlineLayerId: null, displayName: 'B' },
                C: { mapLayerId: 'layer-C', outlineLayerId: null, displayName: 'C' },
            },
        );
        const r = mm.moveLayerToTop('A');
        expect(r.success).toBe(true);
        expect(r.layer).toBe('A');
        expect(mm.map._stack()).toEqual(['layer-B', 'layer-C', 'layer-A']);
    });

    it('moves a fill+outline group atomically with outline on top of fill', () => {
        const mm = createManager(
            [
                { id: 'layer-A' }, { id: 'layer-A-outline' },
                { id: 'layer-B' }, { id: 'layer-B-outline' },
            ],
            {
                A: { mapLayerId: 'layer-A', outlineLayerId: 'layer-A-outline', displayName: 'A' },
                B: { mapLayerId: 'layer-B', outlineLayerId: 'layer-B-outline', displayName: 'B' },
            },
        );
        mm.moveLayerToTop('A');
        expect(mm.map._stack()).toEqual([
            'layer-B', 'layer-B-outline',
            'layer-A', 'layer-A-outline',
        ]);
    });

    it('returns success=false with error when the layerId is unknown', () => {
        const mm = createManager(
            [{ id: 'layer-A' }],
            { A: { mapLayerId: 'layer-A', outlineLayerId: null } },
        );
        const r = mm.moveLayerToTop('missing');
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/Unknown layer/);
    });

    it('is a no-op when the layer is already at the top', () => {
        const mm = createManager(
            [{ id: 'layer-A' }, { id: 'layer-B' }],
            {
                A: { mapLayerId: 'layer-A', outlineLayerId: null },
                B: { mapLayerId: 'layer-B', outlineLayerId: null },
            },
        );
        const r = mm.moveLayerToTop('B');
        expect(r.success).toBe(true);
        expect(mm.map._stack()).toEqual(['layer-A', 'layer-B']);
    });
});
