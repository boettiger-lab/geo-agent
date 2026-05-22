import { describe, it, expect } from 'vitest';
import { MapManager } from '../app/map-manager.js';

/**
 * Bare MapManager mock — just enough for cycle-top-layer logic.
 * `styleLayers` is the simulated MapLibre stack in bottom-to-top order.
 */
function createManager(styleLayers, logicalLayers) {
    const stack = [...styleLayers];
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

    it('returns [fill, outline] in bottom-to-top order for a fill+outline', () => {
        const mm = createManager(
            [{ id: 'layer-A' }, { id: 'layer-A-outline' }],
            { A: { mapLayerId: 'layer-A', outlineLayerId: 'layer-A-outline' } },
        );
        expect(mm._mapSublayersFor('A')).toEqual(['layer-A', 'layer-A-outline']);
    });

    it('flattens all version sublayers in bottom-to-top order', () => {
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

    it('returns [] for an animation-type layer (mapLayerId null)', () => {
        const mm = createManager([], {
            Anim: { mapLayerId: null, outlineLayerId: null, type: 'animation' },
        });
        expect(mm._mapSublayersFor('Anim')).toEqual([]);
    });

    it('returns [] for an unknown layerId', () => {
        const mm = createManager([], {});
        expect(mm._mapSublayersFor('missing')).toEqual([]);
    });
});

function withVisibility(mm, visibilityMap) {
    for (const [id, visible] of Object.entries(visibilityMap)) {
        const state = mm.layers.get(id);
        if (state) state.visible = visible;
    }
    return mm;
}

describe('MapManager.sendTopVisibleLayerToBack', () => {
    it('demotes the topmost visible layer to just above the floor', () => {
        const mm = withVisibility(createManager(
            [{ id: 'layer-A' }, { id: 'layer-B' }, { id: 'layer-C' }],
            {
                A: { mapLayerId: 'layer-A', outlineLayerId: null, type: 'vector' },
                B: { mapLayerId: 'layer-B', outlineLayerId: null, type: 'vector' },
                C: { mapLayerId: 'layer-C', outlineLayerId: null, type: 'vector' },
            },
        ), { A: true, B: true, C: true });
        const r = mm.sendTopVisibleLayerToBack();
        expect(r).toEqual({ success: true, layer: 'C' });
        expect(mm.map._stack()).toEqual(['layer-C', 'layer-A', 'layer-B']);
    });

    it('moves fill+outline group atomically — outline stays above fill', () => {
        const mm = withVisibility(createManager(
            [
                { id: 'layer-A' }, { id: 'layer-A-outline' },
                { id: 'layer-B' }, { id: 'layer-B-outline' },
            ],
            {
                A: { mapLayerId: 'layer-A', outlineLayerId: 'layer-A-outline', type: 'vector' },
                B: { mapLayerId: 'layer-B', outlineLayerId: 'layer-B-outline', type: 'vector' },
            },
        ), { A: true, B: true });
        mm.sendTopVisibleLayerToBack();
        expect(mm.map._stack()).toEqual([
            'layer-B', 'layer-B-outline',
            'layer-A', 'layer-A-outline',
        ]);
    });

    it('moves all version sublayers together for a versioned top layer', () => {
        const mm = withVisibility(createManager(
            [
                { id: 'layer-A' },
                { id: 'layer-V--v-0' }, { id: 'layer-V--v-0-outline' },
                { id: 'layer-V--v-1' }, { id: 'layer-V--v-1-outline' },
            ],
            {
                A: { mapLayerId: 'layer-A', outlineLayerId: null, type: 'vector' },
                V: {
                    mapLayerId: 'layer-V--v-0',
                    outlineLayerId: 'layer-V--v-0-outline',
                    type: 'vector',
                    versions: [
                        { mapLayerId: 'layer-V--v-0', outlineLayerId: 'layer-V--v-0-outline' },
                        { mapLayerId: 'layer-V--v-1', outlineLayerId: 'layer-V--v-1-outline' },
                    ],
                },
            },
        ), { A: true, V: true });
        const r = mm.sendTopVisibleLayerToBack();
        expect(r.layer).toBe('V');
        expect(mm.map._stack()).toEqual([
            'layer-V--v-0', 'layer-V--v-0-outline',
            'layer-V--v-1', 'layer-V--v-1-outline',
            'layer-A',
        ]);
    });

    it('skips hidden layers when finding top visible', () => {
        const mm = withVisibility(createManager(
            [{ id: 'layer-A' }, { id: 'layer-B' }, { id: 'layer-C' }],
            {
                A: { mapLayerId: 'layer-A', outlineLayerId: null, type: 'vector' },
                B: { mapLayerId: 'layer-B', outlineLayerId: null, type: 'vector' },
                C: { mapLayerId: 'layer-C', outlineLayerId: null, type: 'vector' },
            },
        ), { A: true, B: true, C: false });
        const r = mm.sendTopVisibleLayerToBack();
        expect(r.layer).toBe('B');
        expect(mm.map._stack()).toEqual(['layer-B', 'layer-A', 'layer-C']);
    });

    it('skips animation-type layers when finding top visible', () => {
        const mm = withVisibility(createManager(
            [{ id: 'layer-A' }, { id: 'layer-B' }],
            {
                A: { mapLayerId: 'layer-A', outlineLayerId: null, type: 'vector' },
                B: { mapLayerId: 'layer-B', outlineLayerId: null, type: 'vector' },
                Anim: { mapLayerId: null, outlineLayerId: null, type: 'animation' },
            },
        ), { A: true, B: true, Anim: true });
        const r = mm.sendTopVisibleLayerToBack();
        expect(r.layer).toBe('B');
    });

    it('returns insufficient_visible_layers when 0 visible', () => {
        const mm = withVisibility(createManager(
            [{ id: 'layer-A' }, { id: 'layer-B' }],
            {
                A: { mapLayerId: 'layer-A', outlineLayerId: null, type: 'vector' },
                B: { mapLayerId: 'layer-B', outlineLayerId: null, type: 'vector' },
            },
        ), { A: false, B: false });
        const r = mm.sendTopVisibleLayerToBack();
        expect(r).toEqual({ success: true, layer: null, reason: 'insufficient_visible_layers' });
        expect(mm.map._stack()).toEqual(['layer-A', 'layer-B']);
    });

    it('returns insufficient_visible_layers when only 1 visible', () => {
        const mm = withVisibility(createManager(
            [{ id: 'layer-A' }, { id: 'layer-B' }],
            {
                A: { mapLayerId: 'layer-A', outlineLayerId: null, type: 'vector' },
                B: { mapLayerId: 'layer-B', outlineLayerId: null, type: 'vector' },
            },
        ), { A: true, B: false });
        const r = mm.sendTopVisibleLayerToBack();
        expect(r.layer).toBe(null);
        expect(mm.map._stack()).toEqual(['layer-A', 'layer-B']);
    });

    it('cycles through visible layers with period N', () => {
        const mm = withVisibility(createManager(
            [{ id: 'layer-A' }, { id: 'layer-B' }, { id: 'layer-C' }, { id: 'layer-D' }],
            {
                A: { mapLayerId: 'layer-A', outlineLayerId: null, type: 'vector' },
                B: { mapLayerId: 'layer-B', outlineLayerId: null, type: 'vector' },
                C: { mapLayerId: 'layer-C', outlineLayerId: null, type: 'vector' },
                D: { mapLayerId: 'layer-D', outlineLayerId: null, type: 'vector' },
            },
        ), { A: true, B: true, C: true, D: true });
        const before = mm.map._stack().slice();
        for (let i = 0; i < 4; i++) mm.sendTopVisibleLayerToBack();
        expect(mm.map._stack()).toEqual(before);
    });
});
