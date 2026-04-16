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
