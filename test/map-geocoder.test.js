import { describe, it, expect, vi } from 'vitest';
import { toCarmenFeature, buildGeocoderApi } from '../app/map-geocoder.js';

// Only the pure adapter helpers are tested here. addSearchBox() loads the
// maplibre-gl-geocoder library and touches the DOM/map — verified manually in
// a deployed app (consistent with the project's browser-bound coverage policy).

const RESULT = {
    lat: 37.8393, lon: -119.5165,
    bbox: [-119.886, 37.492, -119.199, 38.186],
    display_name: 'Yosemite National Park, California, United States',
    match_quality: 'high', source: 'nominatim',
};

describe('toCarmenFeature', () => {
    it('maps a GeocodeResult to a Carmen GeoJSON Point feature', () => {
        const f = toCarmenFeature(RESULT);
        expect(f.type).toBe('Feature');
        expect(f.geometry).toEqual({ type: 'Point', coordinates: [-119.5165, 37.8393] });
        expect(f.center).toEqual([-119.5165, 37.8393]);
        expect(f.place_name).toBe(RESULT.display_name);
        expect(f.text).toBe(RESULT.display_name);
        expect(f.bbox).toEqual(RESULT.bbox);
        expect(f.properties).toMatchObject({ match_quality: 'high', source: 'nominatim' });
    });

    it('omits bbox when the result has none', () => {
        const f = toCarmenFeature({ ...RESULT, bbox: null });
        expect('bbox' in f).toBe(false);
    });
});

describe('buildGeocoderApi', () => {
    it('forwardGeocode passes query+limit through and wraps results as features', async () => {
        const forwardGeocode = vi.fn(async () => [RESULT]);
        const api = buildGeocoderApi({ forwardGeocode });
        const out = await api.forwardGeocode({ query: 'Yosemite', limit: 4 });
        expect(forwardGeocode).toHaveBeenCalledWith('Yosemite', { limit: 4 });
        expect(out.features).toHaveLength(1);
        expect(out.features[0].place_name).toBe(RESULT.display_name);
    });

    it('forwardGeocode returns no features when the backend throws', async () => {
        const api = buildGeocoderApi({ forwardGeocode: async () => { throw new Error('boom'); } });
        expect(await api.forwardGeocode({ query: 'x' })).toEqual({ features: [] });
    });

    it('reverseGeocode unpacks [lon,lat] and returns the single match', async () => {
        const reverseGeocode = vi.fn(async () => RESULT);
        const api = buildGeocoderApi({ reverseGeocode });
        const out = await api.reverseGeocode({ query: [-119.5165, 37.8393] });
        expect(reverseGeocode).toHaveBeenCalledWith(37.8393, -119.5165);
        expect(out.features).toHaveLength(1);
    });

    it('reverseGeocode returns no features when there is no match', async () => {
        const api = buildGeocoderApi({ reverseGeocode: async () => null });
        expect(await api.reverseGeocode({ query: [0, 0] })).toEqual({ features: [] });
    });
});
