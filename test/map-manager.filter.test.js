import { describe, it, expect, beforeEach } from 'vitest';
import { MapManager } from '../app/map-manager.js';

/**
 * Bare MapManager mock exposing only the surface setFilter touches:
 * a single registered vector layer and a map that records setFilter calls.
 */
function createManager(featuresInView = 3) {
    const setFilterCalls = [];
    const map = {
        setFilter: (id, f) => setFilterCalls.push({ id, f }),
        queryRenderedFeatures: () => Array.from({ length: featuresInView }, () => ({})),
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

describe('MapManager._applyControlAction (reactive slider, #147)', () => {
    const setup = (extra = {}) => {
        const setFilterCalls = [];
        const queryCalls = { n: 0 };
        const mm = Object.create(MapManager.prototype);
        mm.map = {
            setFilter: (id, f) => setFilterCalls.push({ id, f }),
            queryRenderedFeatures: () => { queryCalls.n++; return []; },
        };
        mm.layers = new Map([
            ['vec', { type: 'vector', mapLayerId: 'layer-vec', outlineLayerId: 'layer-vec-outline', displayName: 'Vec', ...extra }],
        ]);
        mm._setFilterCalls = setFilterCalls;
        mm._queryCalls = queryCalls;
        return mm;
    };

    it('applies the slider expression to the layer and its outline', () => {
        const mm = setup();
        mm._applyControlAction('vec', { kind: 'filter', expr: ['<=', ['get', 'YEAR_'], 1990] });
        expect(mm._setFilterCalls).toEqual([
            { id: 'layer-vec', f: ['<=', ['get', 'YEAR_'], 1990] },
            { id: 'layer-vec-outline', f: ['<=', ['get', 'YEAR_'], 1990] },
        ]);
    });

    it('does NOT call queryRenderedFeatures (cheap per-frame path, unlike setFilter)', () => {
        const mm = setup();
        mm._applyControlAction('vec', { kind: 'filter', expr: ['<=', ['get', 'YEAR_'], 1990] });
        expect(mm._queryCalls.n).toBe(0);
    });

    it('composes the slider predicate with the layer base filter so a defaultFilter survives', () => {
        const base = ['==', ['get', 'severity'], 'high'];
        const mm = setup({ controlBaseFilter: base });
        mm._applyControlAction('vec', { kind: 'filter', expr: ['<=', ['get', 'YEAR_'], 1990] });
        expect(mm._setFilterCalls[0].f).toEqual(['all', base, ['<=', ['get', 'YEAR_'], 1990]]);
    });

    it('ignores non-filter actions and unknown layers', () => {
        const mm = setup();
        mm._applyControlAction('vec', { kind: 'style', paint: {} });
        mm._applyControlAction('missing', { kind: 'filter', expr: ['<=', ['get', 'x'], 1] });
        expect(mm._setFilterCalls.length).toBe(0);
    });
});

describe('MapManager.setFilter 0-features-in-view', () => {
    it('reports plain success with no failure signal when 0 features are in the viewport', () => {
        // queryRenderedFeatures is viewport-scoped: a valid filter whose matches are
        // off-screen returns 0 here. The result must NOT flag that as a problem — a
        // warning here was being relayed to users as "filter matched nothing / is
        // wrong". featuresInView is plain data; 0 just means none in the current view.
        const mm = createManager(0);
        const expr = ['==', ['get', 'admin_agency'], 'NPS'];
        const r = mm.setFilter('vec', expr);

        expect(r.success).toBe(true);
        expect(r.featuresInView).toBe(0);
        // No warning / error / "no match" failure signal — the filter applied fine.
        expect(r.warning).toBeUndefined();
        expect(r.error).toBeUndefined();
    });
});
