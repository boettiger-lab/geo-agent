import { describe, it, expect } from 'vitest';
import { MapManager } from '../app/map-manager.js';

/**
 * Stub the small MapLibre surface getExportState() reads. getStyle() returns
 * a fresh object each call (as MapLibre does) so the method's mutation can't
 * leak back into the live map.
 */
function createManager({ globe = false, style } = {}) {
    const map = {
        getStyle: () => JSON.parse(JSON.stringify(style)),
        getCenter: () => ({ lng: -119.4, lat: 36.8 }),
        getZoom: () => 6.5,
        getBearing: () => 12,
        getPitch: () => 30,
    };
    const mm = Object.create(MapManager.prototype);
    mm.map = map;
    mm._globeEnabled = globe;
    return mm;
}

describe('MapManager.getExportState', () => {
    const styleWithTerrain = () => ({
        version: 8,
        terrain: { source: 'terrain-dem', exaggeration: 1.5 },
        sources: {
            'terrain-dem': { type: 'raster-dem', url: 'https://api.maptiler.com/x?key=SECRET' },
            natgeo: { type: 'raster', tiles: ['https://example/{z}/{x}/{y}.png'] },
        },
        layers: [{ id: 'natgeo-base', type: 'raster', source: 'natgeo' }],
    });

    it('captures the camera and projection', () => {
        const s = createManager({ globe: true, style: styleWithTerrain() }).getExportState();
        expect(s.center).toEqual([-119.4, 36.8]);
        expect(s.zoom).toBe(6.5);
        expect(s.bearing).toBe(12);
        expect(s.pitch).toBe(30);
        expect(s.projection).toBe('globe');
    });

    it('reports mercator when the globe is off', () => {
        const s = createManager({ globe: false, style: styleWithTerrain() }).getExportState();
        expect(s.projection).toBe('mercator');
    });

    it('strips terrain and its keyed DEM source (must not leak the MapTiler key)', () => {
        const s = createManager({ style: styleWithTerrain() }).getExportState();
        expect(s.style.terrain).toBeUndefined();
        expect(s.style.sources['terrain-dem']).toBeUndefined();
        expect(s.style.sources.natgeo).toBeDefined();
        expect(JSON.stringify(s.style)).not.toContain('SECRET');
    });

    it('keeps the full style (sources + layers) for re-hydration', () => {
        const s = createManager({ style: styleWithTerrain() }).getExportState();
        expect(s.style.layers[0].id).toBe('natgeo-base');
        expect(s.style.version).toBe(8);
    });
});
