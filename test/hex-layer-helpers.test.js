import { describe, it, expect } from 'vitest';
import { extractHashFromUrl, rewriteValueColumn, metadataUrlFromTileUrl, buildHeightExpression, buildFlatHeightExpression, defaultExtrusionMaxHeight } from '../app/hex-layer-helpers.js';

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

import { PALETTES, buildFillColorExpression, buildFlatFillColorExpression } from '../app/hex-layer-helpers.js';

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

describe('buildFlatFillColorExpression', () => {
  it('builds a case-wrapped flat interpolate (no res match)', () => {
    const expr = buildFlatFillColorExpression('count', { min: 1, max: 100 }, 'viridis');

    expect(expr[0]).toBe('case');
    expect(expr[1]).toEqual(['==', ['get', 'count'], null]);
    expect(expr[2]).toBe('rgba(0,0,0,0)');

    // No `match` / no `['get','res']` — interpolates directly over the value.
    expect(expr[3]).toEqual(['interpolate', ['linear'], ['get', 'count'],
      1, '#440154', 50.5, '#21918c', 100, '#fde725']);
  });

  it('collapses a min == max range to the palette midpoint color', () => {
    const expr = buildFlatFillColorExpression('count', { min: 5, max: 5 }, 'viridis');
    expect(expr[3]).toBe('#21918c');
  });

  it('throws on unknown palette', () => {
    expect(() => buildFlatFillColorExpression('v', { min: 0, max: 1 }, 'nope'))
        .toThrow(/Unknown palette/);
  });

  it('throws when stats lack numeric min/max', () => {
    expect(() => buildFlatFillColorExpression('v', null, 'viridis')).toThrow(/min and max/);
    expect(() => buildFlatFillColorExpression('v', { min: 0 }, 'viridis')).toThrow(/min and max/);
  });
});

describe('rewriteValueColumn', () => {
  it('repoints a guessed ["get","count"] to the real value column', () => {
    const expr = ['interpolate', ['linear'], ['get', 'count'], 1, '#440154', 125, '#FDE725'];
    const { value, replaced } = rewriteValueColumn(expr, 'species_richness');
    expect(value).toEqual(
      ['interpolate', ['linear'], ['get', 'species_richness'], 1, '#440154', 125, '#FDE725']);
    expect(replaced).toEqual(['count']);
  });

  it('leaves an expression that already targets the value column untouched', () => {
    const expr = ['interpolate', ['linear'], ['get', 'species_richness'], 0, '#000', 10, '#fff'];
    const { value, replaced } = rewriteValueColumn(expr, 'species_richness');
    expect(value).toEqual(expr);
    expect(replaced).toEqual([]);
  });

  it('does not touch the per-resolution `res` key', () => {
    const expr = ['case', ['==', ['get', 'count'], null], 'rgba(0,0,0,0)',
      ['match', ['get', 'res'], 3, ['get', 'count'], 'rgba(0,0,0,0)']];
    const { value, replaced } = rewriteValueColumn(expr, 'pop');
    expect(value).toEqual(['case', ['==', ['get', 'pop'], null], 'rgba(0,0,0,0)',
      ['match', ['get', 'res'], 3, ['get', 'pop'], 'rgba(0,0,0,0)']]);
    expect(replaced).toEqual(['count']);
  });

  it('reports each distinct replaced property once', () => {
    const expr = ['+', ['get', 'count'], ['get', 'foo'], ['get', 'count']];
    const { replaced } = rewriteValueColumn(expr, 'val');
    expect(replaced.sort()).toEqual(['count', 'foo']);
  });

  it('passes through literals and non-expression values', () => {
    expect(rewriteValueColumn('red', 'val')).toEqual({ value: 'red', replaced: [] });
    expect(rewriteValueColumn(0.7, 'val')).toEqual({ value: 0.7, replaced: [] });
  });

  it('leaves longer get forms (["get", key, obj]) alone', () => {
    const expr = ['get', 'count', ['properties']];
    const { value, replaced } = rewriteValueColumn(expr, 'val');
    expect(value).toEqual(expr);
    expect(replaced).toEqual([]);
  });
});

describe('metadataUrlFromTileUrl (#276)', () => {
  it('swaps the /{z}/{x}/{y}.pbf suffix for metadata.json', () => {
    expect(metadataUrlFromTileUrl(
      'https://duckdb-mcp.nrp-nautilus.io/tiles/hex/abc123/{z}/{x}/{y}.pbf'))
      .toBe('https://duckdb-mcp.nrp-nautilus.io/tiles/hex/abc123/metadata.json');
  });

  it('returns null for a non-hex-template URL', () => {
    expect(metadataUrlFromTileUrl('https://h/tiles/hex/abc/6/10/24.pbf')).toBeNull();
    expect(metadataUrlFromTileUrl('https://h/other/abc/{z}/{x}/{y}.pbf')).toBeNull();
    expect(metadataUrlFromTileUrl('not a url')).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(metadataUrlFromTileUrl(null)).toBeNull();
    expect(metadataUrlFromTileUrl(undefined)).toBeNull();
  });
});

describe('buildHeightExpression (#317)', () => {
  it('mirrors the color match: per-res interpolate onto [0, maxHeight]', () => {
    const stats = { by_res: { '3': { min: 1, max: 100 }, '4': { min: 1, max: 20 } } };
    const expr = buildHeightExpression('count', stats, 1000);

    expect(expr[0]).toBe('case');
    expect(expr[1]).toEqual(['==', ['get', 'count'], null]);
    expect(expr[2]).toBe(0); // null value → zero height

    const match = expr[3];
    expect(match[0]).toBe('match');
    expect(match[1]).toEqual(['get', 'res']);
    expect(match[2]).toBe(3);
    expect(match[3]).toEqual(['interpolate', ['linear'], ['get', 'count'], 1, 0, 100, 1000]);
    expect(match[4]).toBe(4);
    expect(match[5]).toEqual(['interpolate', ['linear'], ['get', 'count'], 1, 0, 20, 1000]);
    expect(match).toHaveLength(7);
    expect(match[6]).toBe(0); // unknown res → zero height
  });

  it('collapses a min == max resolution to half height', () => {
    const stats = { by_res: { '5': { min: 1, max: 1 } } };
    const match = buildHeightExpression('count', stats, 1000)[3];
    expect(match[3]).toBe(500);
  });

  it('throws when by_res is empty', () => {
    expect(() => buildHeightExpression('count', { by_res: {} }, 1000)).toThrow();
  });
});

describe('buildFlatHeightExpression (#317)', () => {
  it('interpolates a single domain onto [0, maxHeight]', () => {
    const expr = buildFlatHeightExpression('count', { min: 0, max: 50 }, 800);
    expect(expr[0]).toBe('case');
    expect(expr[2]).toBe(0);
    expect(expr[3]).toEqual(['interpolate', ['linear'], ['get', 'count'], 0, 0, 50, 800]);
  });

  it('collapses min == max to half height', () => {
    const expr = buildFlatHeightExpression('count', { min: 5, max: 5 }, 800);
    expect(expr[3]).toBe(400);
  });
});

describe('defaultExtrusionMaxHeight (#317)', () => {
  it('scales to ~8% of the smaller ground span', () => {
    // ~1° lat ≈ 110.54 km; a 1°×1° box near the equator → span ~110 km → ~8.8 km.
    const h = defaultExtrusionMaxHeight([0, 0, 1, 1]);
    expect(h).toBeGreaterThan(8000);
    expect(h).toBeLessThan(10000);
  });

  it('falls back to a fixed height for unusable bounds', () => {
    expect(defaultExtrusionMaxHeight(null)).toBe(50000);
    expect(defaultExtrusionMaxHeight([0, 0, 1])).toBe(50000);
    expect(defaultExtrusionMaxHeight([0, 0, 'x', 1])).toBe(50000);
  });

  it('never returns below the 1 km floor for a tiny extent', () => {
    expect(defaultExtrusionMaxHeight([0, 0, 0.0001, 0.0001])).toBe(1000);
  });
});
