import { describe, it, expect, vi } from 'vitest';
import { createGeocoder, _internal } from '../app/geocoder.js';

const okJson = (body) => ({ ok: true, json: async () => body });
const errJson = (status) => ({ ok: false, status, json: async () => ({}) });

// Real response fixtures (trimmed) captured from the live APIs.
const NOMINATIM_YOSEMITE = [{
    lat: '37.8393004',
    lon: '-119.5164635',
    importance: 0.5857662850918021,
    boundingbox: ['37.4921493', '38.1863499', '-119.8861599', '-119.1995075'],
    display_name: 'Yosemite National Park, California, United States',
}];

const NOMINATIM_ADDRESS = [{
    lat: '34.0266169',
    lon: '-118.3241943',
    importance: 8.738155184248139e-05,
    display_name: 'Sixth Avenue Elementary School, 3109, 6th Avenue, Los Angeles, California, 90018, United States',
}];

const PHOTON_YOSEMITE = {
    features: [{
        geometry: { coordinates: [-119.5164635, 37.8393004] },
        properties: {
            name: 'Yosemite National Park',
            state: 'California',
            country: 'United States',
            extent: [-119.8861599, 38.1863499, -119.1995075, 37.4921493],
        },
    }],
};

const MAPTILER_YOSEMITE = {
    features: [{
        place_name: 'Yosemite National Park, California, United States',
        center: [-119.5164635, 37.8393004],
        bbox: [-119.8861599, 37.4921493, -119.1995075, 38.1863499],
        relevance: 0.9,
    }],
};

describe('createGeocoder factory', () => {
    it('defaults to the nominatim provider', () => {
        expect(createGeocoder().provider).toBe('nominatim');
    });

    it('throws when maptiler is selected without a key', () => {
        expect(() => createGeocoder({ provider: 'maptiler' })).toThrow(/maptiler_key/);
    });

    it('throws on an unknown provider', () => {
        expect(() => createGeocoder({ provider: 'bogus' })).toThrow(/Unknown geocoder provider/);
    });
});

describe('forwardGeocode — nominatim (default)', () => {
    it('normalizes lat/lon/bbox/display_name and reorders bbox to [w,s,e,n]', async () => {
        const fetchImpl = vi.fn(async () => okJson(NOMINATIM_YOSEMITE));
        const g = createGeocoder({ fetchImpl });
        const [r] = await g.forwardGeocode('Yosemite National Park');

        expect(r.lat).toBeCloseTo(37.8393, 3);
        expect(r.lon).toBeCloseTo(-119.5165, 3);
        // boundingbox [s, n, w, e] → bbox [w, s, e, n]
        expect(r.bbox).toEqual([-119.8861599, 37.4921493, -119.1995075, 38.1863499]);
        expect(r.display_name).toMatch(/Yosemite National Park/);
        expect(r.match_quality).toBe('high');   // importance 0.58
        expect(r.source).toBe('nominatim');
    });

    it('marks a low-importance address match as low quality and tolerates a missing bbox', async () => {
        const g = createGeocoder({ fetchImpl: async () => okJson(NOMINATIM_ADDRESS) });
        const [r] = await g.forwardGeocode('3109 6th Ave, Los Angeles 90018');
        expect(r.lat).toBeCloseTo(34.0266, 3);
        expect(r.bbox).toBeNull();
        expect(r.match_quality).toBe('low');
    });

    it('builds the search URL with query, limit, and the contact email', async () => {
        const fetchImpl = vi.fn(async () => okJson([]));
        const g = createGeocoder({ fetchImpl, email: 'ops@example.org' });
        await g.forwardGeocode('Chicago', { limit: 3 });
        const url = fetchImpl.mock.calls[0][0];
        expect(url).toContain('nominatim.openstreetmap.org/search');
        expect(url).toContain('q=Chicago');
        expect(url).toContain('limit=3');
        expect(url).toContain('email=ops%40example.org');
    });

    it('clamps limit to [1,10]', async () => {
        const fetchImpl = vi.fn(async () => okJson([]));
        const g = createGeocoder({ fetchImpl });
        await g.forwardGeocode('x', { limit: 99 });
        expect(fetchImpl.mock.calls[0][0]).toContain('limit=10');
    });

    it('returns [] for blank input without calling fetch', async () => {
        const fetchImpl = vi.fn(async () => okJson([]));
        const g = createGeocoder({ fetchImpl });
        expect(await g.forwardGeocode('   ')).toEqual([]);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('throws including the HTTP status on a non-OK response', async () => {
        const g = createGeocoder({ fetchImpl: async () => errJson(429) });
        await expect(g.forwardGeocode('x')).rejects.toThrow(/429/);
    });

    it('forwards an AbortSignal to fetch', async () => {
        const fetchImpl = vi.fn(async () => okJson([]));
        const g = createGeocoder({ fetchImpl });
        const ctrl = new AbortController();
        await g.forwardGeocode('x', { signal: ctrl.signal });
        expect(fetchImpl.mock.calls[0][1].signal).toBe(ctrl.signal);
    });

    it('honors an endpoint override (e.g. self-hosted Nominatim)', async () => {
        const fetchImpl = vi.fn(async () => okJson([]));
        const g = createGeocoder({ fetchImpl, endpoint: 'https://geo.internal' });
        await g.forwardGeocode('x');
        expect(fetchImpl.mock.calls[0][0]).toContain('https://geo.internal/search');
    });
});

describe('forwardGeocode — photon', () => {
    it('normalizes coordinates, builds a label, and reorders the extent to [w,s,e,n]', async () => {
        const g = createGeocoder({ provider: 'photon', fetchImpl: async () => okJson(PHOTON_YOSEMITE) });
        const [r] = await g.forwardGeocode('Yosemite');
        expect(r.lat).toBeCloseTo(37.8393, 3);
        expect(r.lon).toBeCloseTo(-119.5165, 3);
        // extent [w, n, e, s] → bbox [w, s, e, n]
        expect(r.bbox).toEqual([-119.8861599, 37.4921493, -119.1995075, 38.1863499]);
        expect(r.display_name).toBe('Yosemite National Park, California, United States');
        expect(r.source).toBe('photon');
    });

    it('targets the photon endpoint', async () => {
        const fetchImpl = vi.fn(async () => okJson({ features: [] }));
        const g = createGeocoder({ provider: 'photon', fetchImpl });
        await g.forwardGeocode('x');
        expect(fetchImpl.mock.calls[0][0]).toContain('photon.komoot.io/api/');
    });
});

describe('forwardGeocode — maptiler', () => {
    it('normalizes center/bbox/place_name and maps relevance to quality', async () => {
        const fetchImpl = vi.fn(async () => okJson(MAPTILER_YOSEMITE));
        const g = createGeocoder({ provider: 'maptiler', maptiler_key: 'KEY', fetchImpl });
        const [r] = await g.forwardGeocode('Yosemite');
        expect(r.lat).toBeCloseTo(37.8393, 3);
        expect(r.bbox).toEqual([-119.8861599, 37.4921493, -119.1995075, 38.1863499]);
        expect(r.match_quality).toBe('high');
        expect(r.source).toBe('maptiler');
        const url = fetchImpl.mock.calls[0][0];
        expect(url).toContain('api.maptiler.com/geocoding/Yosemite.json');
        expect(url).toContain('key=KEY');
    });
});

describe('reverseGeocode', () => {
    it('returns the best single match for coordinates (nominatim)', async () => {
        const g = createGeocoder({ fetchImpl: async () => okJson(NOMINATIM_YOSEMITE[0]) });
        const r = await g.reverseGeocode(37.8393, -119.5165);
        expect(r.display_name).toMatch(/Yosemite/);
        expect(r.source).toBe('nominatim');
    });

    it('returns null for invalid coordinates without calling fetch', async () => {
        const fetchImpl = vi.fn();
        const g = createGeocoder({ fetchImpl });
        expect(await g.reverseGeocode('nope', null)).toBeNull();
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

describe('_internal.bucket', () => {
    it('maps scores to quality buckets and defaults null to medium', () => {
        expect(_internal.bucket(0.9)).toBe('high');
        expect(_internal.bucket(0.3)).toBe('medium');
        expect(_internal.bucket(0.01)).toBe('low');
        expect(_internal.bucket(null)).toBe('medium');
    });
});
