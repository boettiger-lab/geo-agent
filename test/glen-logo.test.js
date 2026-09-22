import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * The hexagon is the H3 motif the whole product leans on, so a stretched one
 * reads as a mistake. An earlier version elongated it to fit the wordmark
 * inside; the wordmark now sits beside the mark instead. These assertions
 * exist so that trade cannot be silently re-made.
 */
const FILES = ['app/assets/glen-logo.svg', 'app/assets/glen-logo-white.svg'];

/** Pull the polygon points out of the mark's `M x,y L x,y ... Z` path. */
function hexPoints(svg) {
    const d = svg.match(/<path d="(M[^"]+Z)"/)[1];
    return [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)]
        .map(([, x, y]) => [Number(x), Number(y)]);
}

const dist = ([ax, ay], [bx, by]) => Math.hypot(ax - bx, ay - by);

describe.each(FILES)('%s', file => {
    const svg = readFileSync(file, 'utf8');

    it('draws a six-sided figure', () => {
        expect(hexPoints(svg)).toHaveLength(6);
    });

    it('is a regular hexagon — all six edges equal', () => {
        const p = hexPoints(svg);
        const edges = p.map((v, i) => dist(v, p[(i + 1) % 6]));
        const spread = Math.max(...edges) - Math.min(...edges);
        expect(spread).toBeLessThan(1e-6);
    });

    it('is a regular hexagon — all six vertices equidistant from the centre', () => {
        const p = hexPoints(svg);
        const cx = p.reduce((a, [x]) => a + x, 0) / 6;
        const cy = p.reduce((a, [, y]) => a + y, 0) / 6;
        const radii = p.map(v => dist(v, [cx, cy]));
        const spread = Math.max(...radii) - Math.min(...radii);
        // Tight on purpose: coordinates are emitted at 4dp, so anything
        // looser would pass a hexagon that is merely close to regular.
        expect(spread).toBeLessThan(1e-6);
    });

    it('carries the GLEN wordmark as text, not as a decorative shape', () => {
        expect(svg).toContain('>GLEN<');
        expect(svg).toMatch(/aria-label="GLEN"/);
    });

    it('is a single ink colour, so the knockout variant is a plain recolour', () => {
        const colours = new Set([...svg.matchAll(/#[0-9a-f]{6}/gi)].map(m => m[0].toLowerCase()));
        expect(colours.size).toBe(1);
    });
});
