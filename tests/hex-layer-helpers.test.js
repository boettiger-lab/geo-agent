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
  it('builds a case-wrapped linear interpolate for a simple range', () => {
    const expr = buildFillColorExpression('val', [0, 10], 'viridis');
    expect(expr).toEqual([
      'case',
      ['==', ['get', 'val'], null],
      'rgba(0,0,0,0)',
      ['interpolate', ['linear'], ['get', 'val'],
        0, '#440154',
        5, '#21918c',
        10, '#fde725',
      ],
    ]);
  });

  it('computes the midpoint correctly for negative-to-positive ranges', () => {
    const expr = buildFillColorExpression('v', [-1, 1], 'bluered');
    const interp = expr[3];
    expect(interp[3]).toBe(-1);
    expect(interp[5]).toBe(0);
    expect(interp[7]).toBe(1);
  });

  it('throws on unknown palette', () => {
    expect(() => buildFillColorExpression('v', [0, 1], 'notapalette'))
        .toThrow(/Unknown palette/);
  });

  it('throws when value_range has min >= max', () => {
    expect(() => buildFillColorExpression('v', [5, 5], 'viridis'))
        .toThrow(/value_range/);
    expect(() => buildFillColorExpression('v', [5, 1], 'viridis'))
        .toThrow(/value_range/);
  });
});
