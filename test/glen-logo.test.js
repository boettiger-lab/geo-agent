import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * The hexagon is the H3 motif the whole product leans on, so a stretched one
 * reads as a mistake. An earlier version elongated it to fit the wordmark
 * inside; the wordmark now sits beside the mark instead. These assertions
 * exist so that trade cannot be silently re-made.
 */
const FILES = ['app/assets/glen-logo.svg', 'app/assets/glen-logo-white.svg'];

/**
 * Pull the polygon points out of the hexagon path, which is the first of the
 * mark's two — the second is the speech bubble.
 */
function hexPoints(svg) {
    const d = svg.match(/<path d="(M[^"]+Z)"/)[1];
    return [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)]
        .map(([, x, y]) => [Number(x), Number(y)]);
}

/** The bubble path: the one with arc commands, which the hexagon has none of. */
function bubblePath(svg) {
    return [...svg.matchAll(/<path d="([^"]+)"/g)]
        .map(m => m[1])
        .find(d => d.includes('A'));
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

    it('holds a speech bubble inside the hexagon — chat over a hex map', () => {
        const bubble = bubblePath(svg);
        expect(bubble).toBeTruthy();

        // Every corner of the bubble, and the tip of its tail, must sit
        // inside the hexagon or the mark looks broken at small sizes.
        const hex = hexPoints(svg);
        // Walk M/L/H/V only. An arc's leading numbers are its radii, not a
        // point, and reading them as coordinates is what a naive regex does.
        // The rounded corners sit inside the box these points describe, so
        // checking them is enough for a convex hexagon.
        const pts = [];
        let x = 0, y = 0;
        for (const [, cmd, args] of bubble.matchAll(/([MLHVAZ])([^MLHVAZ]*)/gi)) {
            const n = (args.match(/-?[\d.]+/g) || []).map(Number);
            const c = cmd.toUpperCase();
            if (c === 'M' || c === 'L') { [x, y] = n; pts.push([x, y]); }
            else if (c === 'H') { [x] = n; pts.push([x, y]); }
            else if (c === 'V') { [y] = n; pts.push([x, y]); }
            else if (c === 'A') { [x, y] = n.slice(-2); }   // endpoint only
        }

        const inside = (px, py) => hex.every((a, i) => {
            const b = hex[(i + 1) % 6];
            return (b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]) >= -1e-6;
        });
        expect(pts.length).toBeGreaterThan(4);
        expect(pts.filter(([x, y]) => !inside(x, y))).toEqual([]);
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
