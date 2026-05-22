import { describe, it, expect, vi } from 'vitest';
import { createMapTools } from '../app/map-tools.js';

const stubMapManager = () => ({
    moveLayerToTop: vi.fn((id) => ({ success: true, layer: id })),
    moveLayerToBottom: vi.fn((id) => ({ success: true, layer: id })),
    moveLayerAbove: vi.fn((id, ref) => ({ success: true, layer: id, referenceLayer: ref })),
    moveLayerBelow: vi.fn((id, ref) => ({ success: true, layer: id, referenceLayer: ref })),
    resetLayerOrder: vi.fn(() => ({ success: true, restoredOrder: ['A', 'B'] })),
    getLayerSummaries: () => [
        { id: 'A', displayName: 'Alpha', type: 'vector' },
        { id: 'B', displayName: 'Bravo', type: 'vector' },
    ],
});

const stubCatalog = () => ({ records: new Map() });

const getTool = (name, mm) => {
    const tools = createMapTools(mm, stubCatalog());
    return tools.find(t => t.name === name);
};

describe('layer-order tools', () => {
    it('move_layer_to_top calls mm.moveLayerToTop and JSON-stringifies', () => {
        const mm = stubMapManager();
        const raw = getTool('move_layer_to_top', mm).execute({ layer_id: 'A' });
        expect(mm.moveLayerToTop).toHaveBeenCalledWith('A');
        expect(JSON.parse(raw)).toEqual({ success: true, layer: 'A' });
    });

    it('move_layer_to_bottom calls mm.moveLayerToBottom', () => {
        const mm = stubMapManager();
        const raw = getTool('move_layer_to_bottom', mm).execute({ layer_id: 'A' });
        expect(mm.moveLayerToBottom).toHaveBeenCalledWith('A');
        expect(JSON.parse(raw).success).toBe(true);
    });

    it('move_layer_above passes layer_id and reference_layer_id', () => {
        const mm = stubMapManager();
        const raw = getTool('move_layer_above', mm).execute({
            layer_id: 'A', reference_layer_id: 'B',
        });
        expect(mm.moveLayerAbove).toHaveBeenCalledWith('A', 'B');
        expect(JSON.parse(raw)).toEqual({
            success: true, layer: 'A', referenceLayer: 'B',
        });
    });

    it('move_layer_below passes layer_id and reference_layer_id', () => {
        const mm = stubMapManager();
        const raw = getTool('move_layer_below', mm).execute({
            layer_id: 'B', reference_layer_id: 'A',
        });
        expect(mm.moveLayerBelow).toHaveBeenCalledWith('B', 'A');
        expect(JSON.parse(raw).success).toBe(true);
    });

    it('reset_layer_order takes no args and returns restoredOrder', () => {
        const mm = stubMapManager();
        const raw = getTool('reset_layer_order', mm).execute({});
        expect(mm.resetLayerOrder).toHaveBeenCalled();
        expect(JSON.parse(raw)).toEqual({
            success: true, restoredOrder: ['A', 'B'],
        });
    });

    it('move_layer_to_top description embeds the layer list', () => {
        const mm = stubMapManager();
        const t = getTool('move_layer_to_top', mm);
        expect(t.description).toMatch(/`A` — Alpha/);
        expect(t.description).toMatch(/`B` — Bravo/);
    });
});
