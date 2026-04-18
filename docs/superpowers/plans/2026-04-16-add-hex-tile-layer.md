# `add_hex_tile_layer` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two client-side tools (`add_hex_tile_layer`, `remove_hex_tile_layer`) so the LLM agent can render dynamic H3 hex MVT tiles produced by `mcp-data-server` v0.3.0's `register_hex_tiles` on the map.

**Architecture:** Extract pure palette + URL logic into a testable module `app/hex-layer-helpers.js`. Add two mutator methods on `MapManager` (`addHexTileLayer` / `removeHexTileLayer`) so `this.layers` has a single write authority. Thin tool definitions in `map-tools.js` marshal args and format results. Introduce minimal vitest setup for unit tests on pure logic and the mutator methods (via a hand-rolled MapLibre mock).

**Tech Stack:** MapLibre GL JS (vector sources, data-driven paint expressions), vitest (new dev dep), ES modules, no new runtime deps.

**Spec:** `docs/superpowers/specs/2026-04-16-add-hex-tile-layer-design.md`

**Branch:** `feat/add-hex-tile-layer` (already created; spec commit is on it)

---

## File Structure

**New files:**
- `vitest.config.js` — minimal test runner config
- `app/hex-layer-helpers.js` — pure functions: `extractHashFromUrl`, `PALETTES`, `buildFillColorExpression`
- `tests/hex-layer-helpers.test.js` — unit tests for the pure module
- `tests/map-manager.hex.test.js` — tests for `MapManager.addHexTileLayer` / `removeHexTileLayer` via a mock map

**Modified files:**
- `package.json` — add `vitest` devDep, add `test` script
- `app/map-manager.js` — import helpers; add `addHexTileLayer()` and `removeHexTileLayer()` methods
- `app/map-tools.js` — add two tool definitions

**Unchanged:**
- No config changes (`layers-input.json`)
- No sidebar / UI changes (sidebar is built from static catalog, so hex layers invisible automatically)
- No downstream HTML changes
- No `config.json` changes

---

## Task 1: Set up vitest

**Files:**
- Modify: `package.json`
- Create: `vitest.config.js`
- Create: `tests/smoke.test.js` (temporary, deleted in Task 2)

- [ ] **Step 1: Install vitest as devDep**

Run:
```bash
cd /home/cboettig/Documents/github/boettiger-lab/geo-agent
npm install --save-dev vitest
```

Expected: `package.json` gains `"vitest": "^X.Y.Z"` under `devDependencies`, `package-lock.json` updates, `node_modules/vitest/` exists.

- [ ] **Step 2: Add test script to `package.json`**

Edit `package.json`. In the `"scripts"` section, add `"test": "vitest run"` alongside existing `docs:*` scripts. Final scripts block should look like:

```json
"scripts": {
  "docs:dev": "vitepress dev docs",
  "docs:build": "vitepress build docs",
  "docs:preview": "vitepress preview docs",
  "test": "vitest run",
  "test:watch": "vitest"
}
```

- [ ] **Step 3: Create `vitest.config.js`**

Create `/home/cboettig/Documents/github/boettiger-lab/geo-agent/vitest.config.js` with:

```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
});
```

- [ ] **Step 4: Create temporary smoke test to verify runner works**

Create `/home/cboettig/Documents/github/boettiger-lab/geo-agent/tests/smoke.test.js`:

```js
import { describe, it, expect } from 'vitest';

describe('vitest setup', () => {
  it('runs a passing test', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 5: Run test to verify pass**

Run:
```bash
cd /home/cboettig/Documents/github/boettiger-lab/geo-agent
npm test
```

Expected: vitest reports `1 passed | 0 failed`.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.js tests/smoke.test.js
git commit -m "test: add vitest infrastructure for unit tests"
```

---

## Task 2: Implement `extractHashFromUrl` (TDD)

**Files:**
- Create: `app/hex-layer-helpers.js`
- Modify: `tests/hex-layer-helpers.test.js` (create this file, delete `tests/smoke.test.js`)

- [ ] **Step 1: Replace smoke test with failing helper tests**

Delete `tests/smoke.test.js` and create `/home/cboettig/Documents/github/boettiger-lab/geo-agent/tests/hex-layer-helpers.test.js`:

```js
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
```

Delete the smoke file:
```bash
rm /home/cboettig/Documents/github/boettiger-lab/geo-agent/tests/smoke.test.js
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
npm test
```

Expected: All 5 tests FAIL with `Failed to resolve import "../app/hex-layer-helpers.js"`.

- [ ] **Step 3: Create `app/hex-layer-helpers.js` with minimal implementation**

Create `/home/cboettig/Documents/github/boettiger-lab/geo-agent/app/hex-layer-helpers.js`:

```js
/**
 * Pure helpers for dynamic H3 hex tile layers.
 *
 * These functions have no DOM / MapLibre dependencies so they're testable
 * without a browser. Consumed by map-manager.js and map-tools.js.
 */

/**
 * Extract the content-addressed hash from an MCP hex tile URL template.
 *
 * @param {string} url - A URL like ".../tiles/hex/<hash>/{z}/{x}/{y}.pbf"
 * @returns {string|null} The hash, or null if the URL doesn't match the pattern.
 */
export function extractHashFromUrl(url) {
    if (typeof url !== 'string' || url.length === 0) return null;
    const match = url.match(/\/tiles\/hex\/([^/]+)\//);
    return match ? match[1] : null;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run:
```bash
npm test
```

Expected: `5 passed | 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add app/hex-layer-helpers.js tests/hex-layer-helpers.test.js
git rm tests/smoke.test.js
git commit -m "feat: add extractHashFromUrl helper for hex tile layers"
```

---

## Task 3: Implement `PALETTES` + `buildFillColorExpression` (TDD)

**Files:**
- Modify: `app/hex-layer-helpers.js`
- Modify: `tests/hex-layer-helpers.test.js`

- [ ] **Step 1: Append failing tests for palette builder**

Add to the bottom of `tests/hex-layer-helpers.test.js`:

```js
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
    expect(interp[4]).toBe(-1);
    expect(interp[6]).toBe(0);
    expect(interp[8]).toBe(1);
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
npm test
```

Expected: new tests FAIL with `PALETTES is not exported` / `buildFillColorExpression is not exported`.

- [ ] **Step 3: Append `PALETTES` and `buildFillColorExpression` to `app/hex-layer-helpers.js`**

Append to `app/hex-layer-helpers.js`:

```js

/**
 * Named 3-stop color palettes for hex-layer fill-color ramps.
 *   viridis — sequential, perceptually uniform (default)
 *   ylorrd  — sequential, warm
 *   bluered — diverging (white midpoint)
 */
export const PALETTES = {
    viridis: ['#440154', '#21918c', '#fde725'],
    ylorrd:  ['#ffffb2', '#fd8d3c', '#bd0026'],
    bluered: ['#2166ac', '#f7f7f7', '#b2182b'],
};

/**
 * Build a MapLibre `fill-color` paint expression for a hex layer.
 *
 * Features with a null value render as transparent; others interpolate
 * linearly from min → mid → max across the chosen palette.
 *
 * @param {string} valueColumn - MVT feature property to color by.
 * @param {[number, number]} valueRange - [min, max]; min must be < max.
 * @param {string} palette - One of the keys in PALETTES.
 * @returns {Array} MapLibre expression.
 */
export function buildFillColorExpression(valueColumn, valueRange, palette) {
    if (!(palette in PALETTES)) {
        throw new Error(`Unknown palette '${palette}'. Valid: ${Object.keys(PALETTES).join(', ')}`);
    }
    const [min, max] = valueRange;
    if (!(min < max)) {
        throw new Error(`value_range collapsed: min (${min}) must be < max (${max})`);
    }
    const mid = (min + max) / 2;
    const [c0, c1, c2] = PALETTES[palette];
    return [
        'case',
        ['==', ['get', valueColumn], null],
        'rgba(0,0,0,0)',
        ['interpolate', ['linear'], ['get', valueColumn],
            min, c0,
            mid, c1,
            max, c2,
        ],
    ];
}
```

- [ ] **Step 4: Run tests to verify pass**

Run:
```bash
npm test
```

Expected: `10 passed | 0 failed` — the 5 `extractHashFromUrl` tests from Task 2 plus the 5 new palette/expression tests added in Step 1 above.

- [ ] **Step 5: Commit**

```bash
git add app/hex-layer-helpers.js tests/hex-layer-helpers.test.js
git commit -m "feat: add PALETTES and buildFillColorExpression for hex layers"
```

---

## Task 4: Write a MapLibre mock + basic `addHexTileLayer` test

**Files:**
- Create: `tests/map-manager.hex.test.js`

- [ ] **Step 1: Create test file with mock map and the first failing test**

Create `/home/cboettig/Documents/github/boettiger-lab/geo-agent/tests/map-manager.hex.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { MapManager } from '../app/map-manager.js';

/**
 * Minimal MapLibre Map mock — records calls and exposes inspectable state.
 * Only implements the methods addHexTileLayer / removeHexTileLayer touch.
 */
function createMockMap() {
    const sources = new Map();
    const layers = new Map();
    const fitBoundsCalls = [];
    return {
        addSource(id, source) {
            if (sources.has(id)) throw new Error(`Source already exists: ${id}`);
            sources.set(id, source);
        },
        getSource(id) { return sources.get(id) || null; },
        removeSource(id) {
            if (!sources.has(id)) throw new Error(`No source: ${id}`);
            sources.delete(id);
        },
        addLayer(layer) {
            if (layers.has(layer.id)) throw new Error(`Layer already exists: ${layer.id}`);
            layers.set(layer.id, layer);
        },
        getLayer(id) { return layers.get(id) || null; },
        removeLayer(id) {
            if (!layers.has(id)) throw new Error(`No layer: ${id}`);
            layers.delete(id);
        },
        setLayoutProperty() {},
        setFilter() {},
        setPaintProperty() {},
        queryRenderedFeatures() { return []; },
        fitBounds(bounds, options) { fitBoundsCalls.push({ bounds, options }); },
        // Introspection helpers (not real MapLibre API)
        _sources: sources,
        _layers: layers,
        _fitBoundsCalls: fitBoundsCalls,
    };
}

/**
 * Build a MapManager with the mock map. MapManager's constructor may
 * call methods on the map — the mock ignores them gracefully.
 */
function createManager() {
    const mm = Object.create(MapManager.prototype);
    mm.map = createMockMap();
    mm.layers = new Map();
    // Stub legend helpers the mutators might call.
    mm._showRasterLegend = () => {};
    mm._hideRasterLegend = () => {};
    return mm;
}

describe('MapManager.addHexTileLayer', () => {
    let mm;
    beforeEach(() => { mm = createManager(); });

    it('registers a vector source and fill layer for a fresh URL', () => {
        const tileUrl = 'https://example.com/tiles/hex/abc123/{z}/{x}/{y}.pbf';
        const result = mm.addHexTileLayer({
            tileUrl,
            valueColumn: 'density',
            valueRange: [0, 1],
            bounds: [-125, 31, -102, 49],
            palette: 'viridis',
            opacity: 0.7,
            displayName: 'Density',
            fitBounds: false,
        });

        expect(result.success).toBe(true);
        expect(result.layer_id).toBe('hex-abc123');
        expect(result.already_exists).toBe(false);

        const src = mm.map._sources.get('hex-abc123');
        expect(src).toEqual({ type: 'vector', tiles: [tileUrl], minzoom: 0, maxzoom: 14 });

        const layer = mm.map._layers.get('hex-abc123');
        expect(layer.type).toBe('fill');
        expect(layer.source).toBe('hex-abc123');
        expect(layer['source-layer']).toBe('hex');
        expect(layer.paint['fill-opacity']).toBe(0.7);

        expect(mm.layers.get('hex-abc123')).toBeDefined();
        expect(mm.layers.get('hex-abc123').displayName).toBe('Density');
        expect(mm.layers.get('hex-abc123').type).toBe('vector');
        expect(mm.layers.get('hex-abc123').sourceLayer).toBe('hex');
    });

    it('calls fitBounds when fitBounds: true', () => {
        mm.addHexTileLayer({
            tileUrl: 'https://example.com/tiles/hex/xyz/{z}/{x}/{y}.pbf',
            valueColumn: 'v', valueRange: [0, 1],
            bounds: [-10, -20, 30, 40],
            palette: 'viridis', opacity: 0.7, displayName: 'X',
            fitBounds: true,
        });
        expect(mm.map._fitBoundsCalls).toHaveLength(1);
        expect(mm.map._fitBoundsCalls[0].bounds).toEqual([[-10, -20], [30, 40]]);
    });

    it('returns error for invalid tileUrl', () => {
        const result = mm.addHexTileLayer({
            tileUrl: 'https://example.com/not-a-hex-url',
            valueColumn: 'v', valueRange: [0, 1],
            bounds: [0, 0, 1, 1], palette: 'viridis',
            opacity: 0.7, displayName: 'X', fitBounds: false,
        });
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/Invalid tile_url/);
    });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:
```bash
npm test
```

Expected: the 3 new tests FAIL with `mm.addHexTileLayer is not a function`.

- [ ] **Step 3: Implement `addHexTileLayer` in `app/map-manager.js`**

Open `/home/cboettig/Documents/github/boettiger-lab/geo-agent/app/map-manager.js`.

At the top, with other imports (add if no imports exist — first check the file):

```js
import { extractHashFromUrl, buildFillColorExpression, PALETTES } from './hex-layer-helpers.js';
```

Inside the `MapManager` class, after the existing `hideLayer` method (around line 462), add:

```js
    // ---- Hex Tile Layers (dynamic MVT from MCP register_hex_tiles) ----

    /**
     * Add a dynamic H3 hex MVT source + fill layer from an MCP tile URL template.
     *
     * See docs/superpowers/specs/2026-04-16-add-hex-tile-layer-design.md for the
     * full contract. Idempotent by hash: re-adding a URL whose hash is already
     * registered returns {already_exists: true} without mutating the map.
     *
     * @param {Object} opts
     * @param {string} opts.tileUrl - from register_hex_tiles.tile_url_template
     * @param {string} opts.valueColumn - which column to color by
     * @param {[number, number]} opts.valueRange - [min, max] of the value
     * @param {[number, number, number, number]} opts.bounds - [w,s,e,n]
     * @param {string} opts.palette - one of PALETTES keys
     * @param {number} opts.opacity - 0..1
     * @param {string} opts.displayName
     * @param {boolean} opts.fitBounds - call map.fitBounds after adding
     * @returns {{success: boolean, layer_id?: string, error?: string, ...}}
     */
    addHexTileLayer(opts) {
        const { tileUrl, valueColumn, valueRange, bounds, palette, opacity, displayName, fitBounds } = opts;

        const hash = extractHashFromUrl(tileUrl);
        if (!hash) {
            return { success: false, error: `Invalid tile_url — expected template from register_hex_tiles ending in /tiles/hex/<hash>/{z}/{x}/{y}.pbf` };
        }
        const layerId = `hex-${hash}`;

        // Idempotency: same URL → same layer → no re-add
        if (this.layers.has(layerId)) {
            const state = this.layers.get(layerId);
            return {
                success: true,
                layer_id: layerId,
                display_name: state.displayName,
                value_column: valueColumn,
                valueRange,
                bounds,
                already_exists: true,
                message: 'Layer already registered. Use remove_hex_tile_layer first to re-add with different styling.',
            };
        }

        let fillColor;
        try {
            fillColor = buildFillColorExpression(valueColumn, valueRange, palette);
        } catch (err) {
            return { success: false, error: err.message };
        }

        const paint = {
            'fill-color': fillColor,
            'fill-opacity': opacity,
            'fill-outline-color': 'rgba(0,0,0,0.15)',
        };

        this.map.addSource(layerId, { type: 'vector', tiles: [tileUrl], minzoom: 0, maxzoom: 14 });
        this.map.addLayer({
            id: layerId,
            type: 'fill',
            source: layerId,
            'source-layer': 'hex',
            layout: { visibility: 'visible' },
            paint,
        });

        this.layers.set(layerId, {
            layerId,
            mapLayerId: layerId,
            outlineLayerId: null,
            sourceId: layerId,
            datasetId: null,
            group: null,
            groupCollapsed: false,
            displayName,
            type: 'vector',
            sourceLayer: 'hex',
            columns: [],
            visible: true,
            filter: null,
            defaultFilter: null,
            defaultPaint: { ...paint },
            tooltipFields: null,
            colormap: null,
            rescale: null,
            legendLabel: null,
            legendType: null,
            legendClasses: null,
        });

        if (fitBounds && Array.isArray(bounds) && bounds.length === 4) {
            const [w, s, e, n] = bounds;
            this.map.fitBounds([[w, s], [e, n]], { padding: 40, duration: 800 });
        }

        return {
            success: true,
            layer_id: layerId,
            display_name: displayName,
            value_column: valueColumn,
            valueRange,
            bounds,
            already_exists: false,
        };
    }
```

- [ ] **Step 4: Run tests to verify pass**

Run:
```bash
npm test
```

Expected: All tests pass (prior tests + 3 new `addHexTileLayer` tests).

- [ ] **Step 5: Commit**

```bash
git add app/map-manager.js tests/map-manager.hex.test.js
git commit -m "feat: MapManager.addHexTileLayer for dynamic MVT hex layers"
```

---

## Task 5: Idempotency test

**Files:**
- Modify: `tests/map-manager.hex.test.js`

- [ ] **Step 1: Append failing idempotency test**

Inside the existing `describe('MapManager.addHexTileLayer', ...)` block in `tests/map-manager.hex.test.js`, append:

```js
    it('is idempotent by hash — second call with same URL returns already_exists', () => {
        const opts = {
            tileUrl: 'https://example.com/tiles/hex/samehash/{z}/{x}/{y}.pbf',
            valueColumn: 'v', valueRange: [0, 1],
            bounds: [0, 0, 1, 1], palette: 'viridis',
            opacity: 0.7, displayName: 'First', fitBounds: false,
        };
        const r1 = mm.addHexTileLayer(opts);
        expect(r1.already_exists).toBe(false);

        const r2 = mm.addHexTileLayer({ ...opts, displayName: 'Second' });
        expect(r2.success).toBe(true);
        expect(r2.already_exists).toBe(true);
        expect(r2.layer_id).toBe(r1.layer_id);

        // No duplicate source or layer — mock would throw on duplicate add
        expect(mm.map._sources.size).toBe(1);
        expect(mm.map._layers.size).toBe(1);
        // Display name unchanged from first call
        expect(mm.layers.get(r1.layer_id).displayName).toBe('First');
    });
```

- [ ] **Step 2: Run tests**

Run:
```bash
npm test
```

Expected: the idempotency test PASSES without changes (already implemented in Task 4). If it fails, fix the implementation before proceeding.

- [ ] **Step 3: Commit**

```bash
git add tests/map-manager.hex.test.js
git commit -m "test: cover idempotent hex layer add-by-hash"
```

---

## Task 6: `removeHexTileLayer` (TDD)

**Files:**
- Modify: `app/map-manager.js`
- Modify: `tests/map-manager.hex.test.js`

- [ ] **Step 1: Append failing tests for remove**

Append to `tests/map-manager.hex.test.js` (after the `addHexTileLayer` describe block):

```js
describe('MapManager.removeHexTileLayer', () => {
    let mm;
    beforeEach(() => { mm = createManager(); });

    function addOne(hash = 'abc') {
        return mm.addHexTileLayer({
            tileUrl: `https://example.com/tiles/hex/${hash}/{z}/{x}/{y}.pbf`,
            valueColumn: 'v', valueRange: [0, 1],
            bounds: [0, 0, 1, 1], palette: 'viridis',
            opacity: 0.7, displayName: 'X', fitBounds: false,
        });
    }

    it('removes an existing hex layer (source, layer, registry entry)', () => {
        const { layer_id } = addOne('abc');
        const r = mm.removeHexTileLayer(layer_id);
        expect(r.success).toBe(true);
        expect(r.layer_id).toBe(layer_id);
        expect(mm.map._sources.has(layer_id)).toBe(false);
        expect(mm.map._layers.has(layer_id)).toBe(false);
        expect(mm.layers.has(layer_id)).toBe(false);
    });

    it('refuses removal of a non-hex layer_id', () => {
        const r = mm.removeHexTileLayer('protected-areas');
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/not a hex layer/);
    });

    it('returns error for unknown hex layer', () => {
        addOne('known');
        const r = mm.removeHexTileLayer('hex-unknown');
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/Unknown hex layer/);
        expect(r.error).toContain('hex-known');
    });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:
```bash
npm test
```

Expected: 3 new tests FAIL with `mm.removeHexTileLayer is not a function`.

- [ ] **Step 3: Implement `removeHexTileLayer`**

In `app/map-manager.js`, immediately after the `addHexTileLayer` method, add:

```js
    /**
     * Remove a dynamic hex tile layer previously added via addHexTileLayer.
     *
     * Refuses any layer_id not starting with `hex-` so curated layers can't
     * be accidentally destroyed.
     *
     * @param {string} layerId - e.g. "hex-abc123"
     * @returns {{success: boolean, layer_id?: string, error?: string}}
     */
    removeHexTileLayer(layerId) {
        if (typeof layerId !== 'string' || !layerId.startsWith('hex-')) {
            return { success: false, error: `layer_id '${layerId}' is not a hex layer (must start with 'hex-')` };
        }
        if (!this.layers.has(layerId)) {
            const hexLayers = [...this.layers.keys()].filter(id => id.startsWith('hex-'));
            return { success: false, error: `Unknown hex layer '${layerId}'. Registered: [${hexLayers.join(', ')}]` };
        }
        this.map.removeLayer(layerId);
        this.map.removeSource(layerId);
        this.layers.delete(layerId);
        return { success: true, layer_id: layerId };
    }
```

- [ ] **Step 4: Run tests to verify pass**

Run:
```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/map-manager.js tests/map-manager.hex.test.js
git commit -m "feat: MapManager.removeHexTileLayer with hex-prefix guard"
```

---

## Task 7: `add_hex_tile_layer` tool in `map-tools.js`

**Files:**
- Modify: `app/map-tools.js`

No unit tests in this task — the tool is a thin dispatcher over `MapManager.addHexTileLayer`, which is already tested. Correctness of the JSON schema / LLM contract is validated by the manual smoke test in Task 9.

- [ ] **Step 1: Add `add_hex_tile_layer` tool definition**

In `/home/cboettig/Documents/github/boettiger-lab/geo-agent/app/map-tools.js`, inside the array returned by `createMapTools`, after the `fly_to` tool (around line 213) and before the `filter_by_query` section (around line 216), add:

```js
        // ---- Dynamic Hex Tile Layers ----
        {
            name: 'add_hex_tile_layer',
            description: `Add a dynamic H3 hex tile layer to the map. Use after calling the MCP \`register_hex_tiles\` tool, which returns a tile URL template + bounds + value columns.

Typical flow for "show me a hex map of X":
  1. Call \`register_hex_tiles\` (MCP) with SQL that returns (h3_index, value1, ...)
  2. Call \`query\` (MCP) for SELECT MIN(col), MAX(col) FROM (<same sql>) to get the value range
  3. Call this tool with the returned tile_url, chosen value_column, and range

IMPORTANT: value_range is required — without it the color ramp is ill-defined. Pass [min, max] as computed above.

IMPORTANT: The tile_url must be the exact tile_url_template returned by register_hex_tiles — the tool rejects other URLs.

The returned layer_id can be used with show_layer / hide_layer / set_style / set_filter / get_map_state like any other vector layer, and with remove_hex_tile_layer to free the source.`,
            inputSchema: {
                type: 'object',
                properties: {
                    tile_url: { type: 'string', description: 'tile_url_template from register_hex_tiles' },
                    value_column: { type: 'string', description: 'Which column from register_hex_tiles.value_columns to style by' },
                    value_range: {
                        type: 'array',
                        items: { type: 'number' },
                        description: '[min, max] of value_column, computed via MCP query'
                    },
                    bounds: {
                        type: 'array',
                        items: { type: 'number' },
                        description: '[w, s, e, n] from register_hex_tiles.bounds'
                    },
                    display_name: { type: 'string', description: 'Optional human-readable layer name (default: "Hex: <value_column>")' },
                    palette: {
                        type: 'string',
                        enum: ['viridis', 'ylorrd', 'bluered'],
                        description: 'Color ramp: viridis (sequential default), ylorrd (warm sequential), bluered (diverging)'
                    },
                    opacity: { type: 'number', description: 'Fill opacity 0..1 (default 0.7)' },
                    fit_bounds: { type: 'boolean', description: 'Fly the camera to fit bounds (default true)' },
                },
                required: ['tile_url', 'value_column', 'value_range', 'bounds'],
            },
            execute: (args) => {
                const displayName = args.display_name || `Hex: ${args.value_column}`;
                const result = mapManager.addHexTileLayer({
                    tileUrl: args.tile_url,
                    valueColumn: args.value_column,
                    valueRange: args.value_range,
                    bounds: args.bounds,
                    palette: args.palette || 'viridis',
                    opacity: args.opacity ?? 0.7,
                    displayName,
                    fitBounds: args.fit_bounds !== false,
                });
                return JSON.stringify(result);
            },
        },
```

- [ ] **Step 2: Run existing tests to confirm nothing regressed**

Run:
```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add app/map-tools.js
git commit -m "feat: add_hex_tile_layer tool for dynamic MVT hex layers (#51)"
```

---

## Task 8: `remove_hex_tile_layer` tool in `map-tools.js`

**Files:**
- Modify: `app/map-tools.js`

- [ ] **Step 1: Add `remove_hex_tile_layer` tool definition**

In `app/map-tools.js`, immediately after the `add_hex_tile_layer` block added in Task 7, add:

```js
        {
            name: 'remove_hex_tile_layer',
            description: `Remove a dynamic hex tile layer previously added via add_hex_tile_layer. Takes a layer_id like "hex-<hash>". Refuses to touch non-hex layers (any id not starting with "hex-"), so curated layers are safe.

Use when the agent is iterating — e.g. user asks to replace one hex analysis with another.`,
            inputSchema: {
                type: 'object',
                properties: {
                    layer_id: { type: 'string', description: 'Hex layer ID, starting with "hex-"' },
                },
                required: ['layer_id'],
            },
            execute: (args) => JSON.stringify(mapManager.removeHexTileLayer(args.layer_id)),
        },
```

- [ ] **Step 2: Run existing tests to confirm nothing regressed**

Run:
```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add app/map-tools.js
git commit -m "feat: remove_hex_tile_layer tool (#51)"
```

---

## Task 9: Manual browser smoke test

**Files:** none (verification only).

This task has no code changes. It verifies the end-to-end flow against the live dev MCP server — the piece the unit tests cannot cover.

- [ ] **Step 1: Prepare `app/config.json` if missing**

Check whether `/home/cboettig/Documents/github/boettiger-lab/geo-agent/app/config.json` exists. If not, copy / create one from the documented template in `docs/guide/configuration.md` with at least one LLM model that can reach the MCP server at `https://duckdb-mcp.nrp-nautilus.io/mcp/`. Ask the user for credentials if needed — do not commit this file (it's gitignored).

- [ ] **Step 2: Start the dev server**

Run:
```bash
cd /home/cboettig/Documents/github/boettiger-lab/geo-agent/app
python -m http.server 8000
```

Expected: server listens on `http://localhost:8000/`.

- [ ] **Step 3: Open the app in a browser and prompt the agent**

Open `http://localhost:8000/` in a browser. In the chat panel, type:

> Show me a hex map of random density values across California at H3 resolution 5.

Expected:
1. Agent calls MCP `register_hex_tiles` with a SQL that produces random values at res 5 over a CA bounding box.
2. Agent calls MCP `query` to get MIN/MAX.
3. Agent calls `add_hex_tile_layer`.
4. Tiles render on the map as a colored hex field over California.
5. Map zooms/pans to the California bounds (auto fit_bounds).

- [ ] **Step 4: Verify `get_map_state` includes the hex layer**

In chat:
> What layers are on the map right now?

Expected: the agent's response (driven by `get_map_state`) lists a `hex-<hash>` layer with the display name you'd expect.

- [ ] **Step 5: Verify removal**

In chat:
> Remove the hex layer.

Expected: agent calls `remove_hex_tile_layer`; the colored hex layer disappears from the map. `get_map_state` no longer lists it.

- [ ] **Step 6: Verify iteration (second layer doesn't collide with first)**

In chat:
> Show me a different hex map — density at resolution 4 instead.

After it renders, add a second request without removing:
> Now also show density at resolution 6.

Expected: both layers render, different hashes, both visible. `get_map_state` shows two `hex-*` entries.

- [ ] **Step 7: Verify DevTools for source cleanup**

In the browser DevTools console, run:
```js
Object.keys(window.mapManager.map.getStyle().sources).filter(k => k.startsWith('hex-'))
```

After calling `remove_hex_tile_layer` on both layers, expect `[]`.

*Note: `window.mapManager` may not be exposed — if not, this step is skipped; the `get_map_state`-via-chat path in Step 5 is sufficient.*

- [ ] **Step 8: If all checks pass, mark the issue ready for PR**

No code changes in this task, so no commit. Proceed to Task 10 (push + PR).

---

## Task 10: Push branch and open PR

**Files:** none.

- [ ] **Step 1: Verify branch state**

Run:
```bash
git log --oneline origin/main..feat/add-hex-tile-layer
```

Expected: lists 8 commits (spec + vitest setup + 6 feature commits from Tasks 2–8).

- [ ] **Step 2: Push branch**

Run:
```bash
git push -u origin feat/add-hex-tile-layer
```

Expected: `remote: Create a pull request ... https://github.com/boettiger-lab/geo-agent/pull/new/feat/add-hex-tile-layer`.

- [ ] **Step 3: Open PR linking issue #51**

Run:
```bash
gh pr create --title "feat: add_hex_tile_layer — render dynamic H3 hex tiles from MCP server" --body "$(cat <<'EOF'
## Summary
- Closes #51
- Adds two client-side tools: `add_hex_tile_layer` and `remove_hex_tile_layer`
- Extracts pure palette / URL logic into `app/hex-layer-helpers.js` (unit-testable)
- Adds minimal vitest infrastructure for unit tests
- New methods on `MapManager` keep single write authority over `this.layers`

## Spec & plan
- Spec: `docs/superpowers/specs/2026-04-16-add-hex-tile-layer-design.md`
- Plan: `docs/superpowers/plans/2026-04-16-add-hex-tile-layer.md`

## Follow-up tracked
- #169 — MapManager decomposition (general refactor question raised during design review)

## Test plan
- [x] `npm test` — all unit tests pass
- [x] Browser smoke against dev MCP server (see Task 9 in the plan):
  - [x] `register_hex_tiles` → `add_hex_tile_layer` renders a hex field
  - [x] Auto-fit zooms to bounds
  - [x] `get_map_state` lists the hex layer
  - [x] `remove_hex_tile_layer` frees source + layer
  - [x] Two hex layers coexist without collision
EOF
)"
```

Expected: PR URL printed.

- [ ] **Step 4: Report PR URL to user**

Output the PR URL for the user to review.

---

## Self-Review checklist (for the author of this plan)

Before handing off:

- [x] Every spec requirement has a task (§1 architecture → Tasks 4–8; §2 value_range → Task 3 validation; §3 lifecycle → Tasks 4 + 6; §4 auto-fit → Task 4 step 3; §5 code location → Tasks 4, 6)
- [x] No `TBD` / `TODO` / "fill in" placeholders
- [x] All function/method names consistent across tasks (`addHexTileLayer`, `removeHexTileLayer`, `extractHashFromUrl`, `buildFillColorExpression`, `PALETTES`)
- [x] Exact file paths everywhere
- [x] Every code step contains the code
- [x] Every run-command step specifies expected output
- [x] Commit messages match repo convention (`feat:`, `test:`, `docs:`)
- [x] Testing plan mismatch resolved — vitest added in Task 1 per user approval
