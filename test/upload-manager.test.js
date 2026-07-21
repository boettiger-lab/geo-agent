import { describe, it, expect } from 'vitest';
import {
    validatePolygonGeoJSON,
    computeBounds,
    pickTooltipFields,
    buildObjectUrl,
    contentHash,
} from '../app/upload-manager.js';

const poly = (coords, props = {}) => ({
    type: 'Feature', properties: props,
    geometry: { type: 'Polygon', coordinates: coords },
});
const SQUARE = [[[-122.3, 37.8], [-122.2, 37.8], [-122.2, 37.9], [-122.3, 37.9], [-122.3, 37.8]]];

describe('validatePolygonGeoJSON', () => {
    it('accepts a FeatureCollection of polygons', () => {
        const r = validatePolygonGeoJSON({ type: 'FeatureCollection', features: [poly(SQUARE)] });
        expect(r.ok).toBe(true);
        expect(r.geometryTypes).toEqual(['Polygon']);
        expect(r.features).toHaveLength(1);
    });

    it('accepts a bare Feature and a MultiPolygon', () => {
        expect(validatePolygonGeoJSON(poly(SQUARE)).ok).toBe(true);
        const mp = { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: [SQUARE] } };
        const r = validatePolygonGeoJSON(mp);
        expect(r.ok).toBe(true);
        expect(r.geometryTypes).toEqual(['MultiPolygon']);
    });

    it('rejects non-objects and wrong top-level types', () => {
        expect(validatePolygonGeoJSON(null).ok).toBe(false);
        expect(validatePolygonGeoJSON({ type: 'Point' }).ok).toBe(false);
    });

    it('rejects empty collections', () => {
        expect(validatePolygonGeoJSON({ type: 'FeatureCollection', features: [] }).ok).toBe(false);
    });

    it('rejects non-polygon geometry, steering to data-ingest', () => {
        const pt = { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [0, 0] } };
        const r = validatePolygonGeoJSON(pt);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/data-ingest/i);
    });

    it('rejects a feature missing geometry', () => {
        const r = validatePolygonGeoJSON({ type: 'Feature', properties: {} });
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/missing geometry/i);
    });

    it('enforces the feature cap', () => {
        const many = { type: 'FeatureCollection', features: Array.from({ length: 5 }, () => poly(SQUARE)) };
        const r = validatePolygonGeoJSON(many, { maxFeatures: 3 });
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/too many features/i);
    });
});

describe('computeBounds', () => {
    it('computes [w,s,e,n] over polygon coordinates', () => {
        expect(computeBounds(poly(SQUARE))).toEqual([-122.3, 37.8, -122.2, 37.9]);
    });

    it('spans multiple features', () => {
        const other = [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]];
        const fc = { type: 'FeatureCollection', features: [poly(SQUARE), poly(other)] };
        expect(computeBounds(fc)).toEqual([-122.3, 0, 1, 37.9]);
    });

    it('returns null when there are no coordinates', () => {
        expect(computeBounds({ type: 'FeatureCollection', features: [] })).toBeNull();
    });
});

describe('pickTooltipFields', () => {
    it('unions property keys across features', () => {
        const feats = [poly(SQUARE, { a: 1, b: 2 }), poly(SQUARE, { b: 3, c: 4 })];
        expect(pickTooltipFields(feats)).toEqual(['a', 'b', 'c']);
    });

    it('caps the number of keys', () => {
        const feats = [poly(SQUARE, { a: 1, b: 2, c: 3, d: 4 })];
        expect(pickTooltipFields(feats, 2)).toEqual(['a', 'b']);
    });

    it('tolerates features without properties', () => {
        expect(pickTooltipFields([{ geometry: {} }])).toEqual([]);
    });
});

describe('buildObjectUrl', () => {
    it('builds a stable public URL and tolerates a trailing slash', () => {
        expect(buildObjectUrl('https://s3.example/bucket', 'uploads', 'abc123'))
            .toBe('https://s3.example/bucket/uploads/abc123/data.geojson');
        expect(buildObjectUrl('https://s3.example/bucket/', 'uploads', 'abc123'))
            .toBe('https://s3.example/bucket/uploads/abc123/data.geojson');
    });
});

describe('contentHash', () => {
    it('is deterministic, 16 hex chars, and content-addressed', async () => {
        const a = await contentHash('{"hello":"world"}');
        const b = await contentHash('{"hello":"world"}');
        const c = await contentHash('{"hello":"there"}');
        expect(a).toBe(b);
        expect(a).not.toBe(c);
        expect(a).toMatch(/^[0-9a-f]{16}$/);
    });
});
