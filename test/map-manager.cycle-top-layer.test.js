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
