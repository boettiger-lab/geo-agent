import { describe, it, expect, beforeEach } from 'vitest';
import { MapManager } from '../app/map-manager.js';

/**
 * Bare MapManager mock exposing only the surface setFilter touches:
 * a single registered vector layer and a map that records setFilter calls.
 */
function createManager() {
    const setFilterCalls = [];
    const map = {
        setFilter: (id, f) => setFilterCalls.push({ id, f }),
        queryRenderedFeatures: () => [{}, {}, {}], // 3 features in view
    };
    const mm = Object.create(MapManager.prototype);
    mm.map = map;
    mm.layers = new Map([
        ['vec', { type: 'vector', mapLayerId: 'layer-vec', displayName: 'Vec' }],
    ]);
    mm._setFilterCalls = setFilterCalls;
    return mm;
}

describe('MapManager.setFilter empty-filter guard (#243)', () => {
    let mm;
    beforeEach(() => { mm = createManager(); });

    it('rejects an empty array [] with an error instead of silent success', () => {
        const r = mm.setFilter('vec', []);
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/empty/i);
        // The no-op filter never reaches the map (would otherwise clear it silently).
        expect(mm._setFilterCalls.length).toBe(0);
    });

    it('applies a valid (non-empty) filter expression', () => {
        const expr = ['==', ['get', 'NO_TAKE'], 'All'];
        const r = mm.setFilter('vec', expr);
        expect(r.success).toBe(true);
        expect(r.filter).toEqual(expr);
        expect(r.featuresInView).toBe(3);
        expect(mm._setFilterCalls[0].f).toEqual(expr);
    });

    it('still allows null to clear — clearFilter passes null, not [] (the guard must not block it)', () => {
        const r = mm.setFilter('vec', null);
        expect(r.success).toBe(true);
        expect(mm._setFilterCalls[0].f).toBe(null);
    });
});
