import { describe, it, expect } from 'vitest';
import { sampleTrack, cellBoundary } from '../app/animation-manager.js';

const T = (h) => new Date(`2026-01-01T${String(h).padStart(2, '0')}:00:00Z`).getTime();
const HOUR = 3600 * 1000;

// Two waypoints, each reported for a two-hour window, with a four-hour gap
// between the end of the first and the start of the second.
const track = {
    coords: [[-121, 40], [-120, 41]],
    times: [T(0), T(6)],
    endTimes: [T(2), T(8)],
};

describe('sampleTrack — smooth mode', () => {
    it('interpolates linearly between waypoints', () => {
        expect(sampleTrack(track, T(3))).toEqual([-120.5, 40.5]);
    });

    it('clamps to the endpoints outside the track range', () => {
        expect(sampleTrack(track, T(0) - HOUR)).toEqual([-121, 40]);
        expect(sampleTrack(track, T(99))).toEqual([-120, 41]);
    });

    it('never returns null inside the range — the path is continuous', () => {
        for (let h = 0; h <= 6; h++) expect(sampleTrack(track, T(h))).not.toBeNull();
    });
});

describe('sampleTrack — stepped mode', () => {
    const stepped = { stepped: true, holdMs: 0 };

    it('holds a waypoint for as long as it was reported', () => {
        expect(sampleTrack(track, T(0), stepped)).toEqual([-121, 40]);
        expect(sampleTrack(track, T(2), stepped)).toEqual([-121, 40]);
    });

    it('shows nothing in the gap between observation windows', () => {
        expect(sampleTrack(track, T(3), stepped)).toBeNull();
        expect(sampleTrack(track, T(5), stepped)).toBeNull();
    });

    it('shows nothing before the first observation or after the last', () => {
        expect(sampleTrack(track, T(0) - HOUR, stepped)).toBeNull();
        expect(sampleTrack(track, T(9), stepped)).toBeNull();
    });

    it('picks up again at the next observation', () => {
        expect(sampleTrack(track, T(7), stepped)).toEqual([-120, 41]);
    });

    it('never interpolates — a returned position is always a waypoint', () => {
        for (let h = 0; h <= 9; h++) {
            const pos = sampleTrack(track, T(h), stepped);
            if (pos) expect(track.coords).toContainEqual(pos);
        }
    });

    it('falls back to the hold window when the data has no end times', () => {
        const noEnds = { ...track, endTimes: null };
        const opts = { stepped: true, holdMs: 1 * HOUR };
        expect(sampleTrack(noEnds, T(0), opts)).toEqual([-121, 40]);
        expect(sampleTrack(noEnds, T(1), opts)).toEqual([-121, 40]);
        expect(sampleTrack(noEnds, T(2), opts)).toBeNull();
    });

    it('extends an observation window by the configured hold', () => {
        const opts = { stepped: true, holdMs: 2 * HOUR };
        expect(sampleTrack(track, T(4), opts)).toEqual([-121, 40]);
        expect(sampleTrack(track, T(5), opts)).toBeNull();
    });
});

describe('cellBoundary', () => {
    // Minimal h3-js stand-in: the real library is browser-loaded from a CDN.
    const fakeH3 = {
        latLngToCell: (lat, lng, res) => `cell-${lat}-${lng}-${res}`,
        cellToBoundary: () => [[-121, 40], [-120.9, 40.1], [-120.8, 40]],
    };

    it('closes the ring returned by h3', () => {
        const ring = cellBoundary([-121, 40], 6, fakeH3);
        expect(ring).toHaveLength(4);
        expect(ring[0]).toEqual(ring[3]);
    });

    it('returns null without an h3 library or a resolution', () => {
        expect(cellBoundary([-121, 40], 6)).toBeNull();
        expect(cellBoundary([-121, 40], null, fakeH3)).toBeNull();
    });
});
