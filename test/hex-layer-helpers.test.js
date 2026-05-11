import { describe, it, expect } from 'vitest';
import { extractHashFromUrl } from '../app/hex-layer-helpers.js';

describe('extractHashFromUrl', () => {
  it('extracts hash from a valid MCP tile URL template', () => {
    const url = 'https://duckdb-mcp.nrp-nautilus.io/tiles/hex/abc123def/{z}/{x}/{y}.pbf';
    expect(extractHashFromUrl(url)).toBe('abc123def');
  });

  it('extracts alphanumeric hashes of varying lengths', () => {
    const url = 'http://example.com/tiles/hex/0123456789abcdef/{z}/{x}/{y}.pbf';
    expect(extractHashFromUrl(url)).toBe('0123456789abcdef');
  });

  it('returns null for a non-hex tile URL', () => {
    expect(extractHashFromUrl('https://example.com/tiles/foo/abc/{z}/{x}/{y}.pbf')).toBe(null);
  });

  it('returns null for a malformed URL', () => {
    expect(extractHashFromUrl('not a url')).toBe(null);
  });

  it('returns null for an empty string', () => {
    expect(extractHashFromUrl('')).toBe(null);
  });
});

import { PALETTES, buildFillColorExpression } from '../app/hex-layer-helpers.js';

describe('PALETTES', () => {
  it('exposes three named 3-stop palettes', () => {
    expect(Object.keys(PALETTES).sort()).toEqual(['bluered', 'viridis', 'ylorrd']);
    for (const name of Object.keys(PALETTES)) {
      expect(PALETTES[name]).toHaveLength(3);
      PALETTES[name].forEach(c => expect(c).toMatch(/^#[0-9a-fA-F]{6}$/));
    }
  });
});

describe('buildFillColorExpression', () => {
  it('builds a case-wrapped match over res with per-resolution interpolate branches', () => {
    const stats = { by_res: { '3': { min: 1, max: 100 }, '4': { min: 1, max: 20 } } };
    const expr = buildFillColorExpression('count', stats, 'viridis');

    expect(expr[0]).toBe('case');
    expect(expr[1]).toEqual(['==', ['get', 'count'], null]);
    expect(expr[2]).toBe('rgba(0,0,0,0)');

    const match = expr[3];
    expect(match[0]).toBe('match');
    expect(match[1]).toEqual(['get', 'res']);

    // Sorted ascending: res 3, then res 4
    expect(match[2]).toBe(3);
    expect(match[3]).toEqual(['interpolate', ['linear'], ['get', 'count'],
      1, '#440154', 50.5, '#21918c', 100, '#fde725']);
    expect(match[4]).toBe(4);
    expect(match[5]).toEqual(['interpolate', ['linear'], ['get', 'count'],
      1, '#440154', 10.5, '#21918c', 20, '#fde725']);

    // Final element of match is the fallback (match length = 2 + 2*n_branches + 1)
    expect(match).toHaveLength(7);
    expect(match[6]).toBe('rgba(0,0,0,0)');
  });

  it('collapses a resolution whose min == max to the palette midpoint color', () => {
    const stats = { by_res: { '5': { min: 1, max: 1 }, '3': { min: 1, max: 10 } } };
    const expr = buildFillColorExpression('count', stats, 'viridis');
    const match = expr[3];

    const idx5 = match.indexOf(5);
    expect(idx5).toBeGreaterThan(0);
    // Collapsed range → literal midpoint color from viridis
    expect(match[idx5 + 1]).toBe('#21918c');

    // Res 3 is still a full interpolate
    const idx3 = match.indexOf(3);
    expect(Array.isArray(match[idx3 + 1])).toBe(true);
    expect(match[idx3 + 1][0]).toBe('interpolate');
  });

  it('handles a single-resolution stats object', () => {
    const stats = { by_res: { '8': { min: 1, max: 50 } } };
    const expr = buildFillColorExpression('count', stats, 'bluered');
    const match = expr[3];
    // 2 (header) + 2 (one branch) + 1 (fallback) = 5
    expect(match).toHaveLength(5);
    expect(match[2]).toBe(8);
    expect(match[3][0]).toBe('interpolate');
  });

  it('sorts resolution branches ascending numerically', () => {
    const stats = { by_res: {
      '10': { min: 1, max: 2 }, '2': { min: 1, max: 100 }, '5': { min: 1, max: 50 },
    } };
    const expr = buildFillColorExpression('count', stats, 'viridis');
    const match = expr[3];
    expect(match[2]).toBe(2);
    expect(match[4]).toBe(5);
    expect(match[6]).toBe(10);
  });

  it('throws on unknown palette', () => {
    const stats = { by_res: { '3': { min: 1, max: 10 } } };
    expect(() => buildFillColorExpression('v', stats, 'notapalette'))
        .toThrow(/Unknown palette/);
  });

  it('throws when by_res is empty', () => {
    expect(() => buildFillColorExpression('v', { by_res: {} }, 'viridis'))
        .toThrow(/by_res/);
  });

  it('throws when value_stats is missing by_res', () => {
    expect(() => buildFillColorExpression('v', {}, 'viridis'))
        .toThrow(/by_res/);
    expect(() => buildFillColorExpression('v', null, 'viridis'))
        .toThrow(/by_res/);
  });
});
