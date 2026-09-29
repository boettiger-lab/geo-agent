// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { detentHeights, nearestDetent, stepDetent, PEEK_PX } from '../app/mobile-sheet.js';

describe('detentHeights', () => {
    it('gives peek / half / full for a typical phone', () => {
        const d = detentHeights(844, 64);       // iPhone-ish, minus the header
        expect(d.peek).toBe(PEEK_PX);
        expect(d.half).toBe(422);
        expect(d.full).toBe(780);
    });

    it('never lets a detent exceed the space available', () => {
        // A short landscape viewport must not produce a half taller than full.
        const d = detentHeights(320, 64);
        expect(d.half).toBeLessThanOrEqual(d.full);
        expect(d.peek).toBeLessThanOrEqual(d.full);
    });

    it('degrades to peek-sized when the header eats the viewport', () => {
        const d = detentHeights(100, 300);
        expect(d.full).toBe(PEEK_PX);
        expect(d.half).toBe(PEEK_PX);
    });

    it('treats a missing header as zero', () => {
        expect(detentHeights(800).full).toBe(800);
    });
});

describe('nearestDetent', () => {
    const d = { peek: 96, half: 400, full: 780 };

    it('snaps to whichever detent the drag ended closest to', () => {
        expect(nearestDetent(100, d)).toBe('peek');
        expect(nearestDetent(380, d)).toBe('half');
        expect(nearestDetent(760, d)).toBe('full');
    });

    it('resolves the midpoints predictably', () => {
        expect(nearestDetent(248, d)).toBe('peek');   // exactly between peek/half
        expect(nearestDetent(249, d)).toBe('half');
        expect(nearestDetent(590, d)).toBe('half');   // exactly between half/full
        expect(nearestDetent(591, d)).toBe('full');
    });

    it('clamps beyond either end', () => {
        expect(nearestDetent(-50, d)).toBe('peek');
        expect(nearestDetent(5000, d)).toBe('full');
    });
});

describe('stepDetent', () => {
    it('moves one step and stops at the ends', () => {
        expect(stepDetent('peek', 1)).toBe('half');
        expect(stepDetent('half', 1)).toBe('full');
        expect(stepDetent('full', 1)).toBe('full');
        expect(stepDetent('half', -1)).toBe('peek');
        expect(stepDetent('peek', -1)).toBe('peek');
    });

    it('falls back for an unknown detent', () => {
        expect(stepDetent('nope', 1)).toBe('peek');
    });
});
