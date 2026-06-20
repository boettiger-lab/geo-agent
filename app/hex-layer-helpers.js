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
 * The MCP pyramid stores hexes at multiple H3 resolutions; aggregate magnitudes
 * scale ~7× per resolution step, so one [min,max] can't paint all levels well.
 * Each MVT feature carries a `res` property — this expression branches on it
 * via `match` to pick the right interpolate domain per resolution.
 *
 * Features with a null value column render transparent. Resolutions with a
 * collapsed range (min == max, e.g. COUNT at finest = 1) render as a flat
 * palette-midpoint color. Unknown resolutions fall back to transparent.
 *
 * @param {string} valueColumn - MVT feature property to color by.
 * @param {{by_res: Object<string, {min: number, max: number}>}} valueStats
 *   Per-resolution stats as returned by `register_hex_tiles.value_stats[column]`.
 * @param {string} palette - One of the keys in PALETTES.
 * @returns {Array} MapLibre expression.
 */
export function buildFillColorExpression(valueColumn, valueStats, palette) {
    if (!(palette in PALETTES)) {
        throw new Error(`Unknown palette '${palette}'. Valid: ${Object.keys(PALETTES).join(', ')}`);
    }
    const byRes = valueStats && valueStats.by_res;
    if (!byRes || Object.keys(byRes).length === 0) {
        throw new Error('value_stats.by_res must contain at least one resolution');
    }

    const [c0, c1, c2] = PALETTES[palette];
    const resKeys = Object.keys(byRes).sort((a, b) => Number(a) - Number(b));

    const branches = [];
    for (const resStr of resKeys) {
        const { min, max } = byRes[resStr];
        const res = Number(resStr);
        let branch;
        if (!(min < max)) {
            branch = c1;
        } else {
            const mid = (min + max) / 2;
            branch = ['interpolate', ['linear'], ['get', valueColumn],
                min, c0, mid, c1, max, c2];
        }
        branches.push(res, branch);
    }

    return [
        'case',
        ['==', ['get', valueColumn], null],
        'rgba(0,0,0,0)',
        ['match', ['get', 'res'], ...branches, 'rgba(0,0,0,0)'],
    ];
}

/**
 * Rewrite the `["get", <prop>]` value references in a MapLibre expression to
 * target a hex layer's actual value column.
 *
 * The agent constructs `set_style` paint expressions without a reliable signal
 * of a dynamic hex layer's value column, so it defaults to `["get", "count"]`
 * (only correct for `agg="COUNT"` tilesets). On a layer whose property is e.g.
 * `species_richness`, that `get` resolves to null on every feature and the ramp
 * yields no color — a silent no-op (see issue #259). This pure walker repoints
 * any value-bearing `get` to `valueColumn` so the recolor takes effect.
 *
 * `res` is left untouched: it's the per-feature resolution key the per-res
 * `match` branches on (see {@link buildFillColorExpression}), not a value.
 *
 * @param {*} expr - A MapLibre paint value (expression array, literal, etc.).
 * @param {string} valueColumn - The layer's real value property.
 * @returns {{ value: *, replaced: string[] }} The rewritten value and the
 *   distinct original property names that were repointed (empty if none).
 */
export function rewriteValueColumn(expr, valueColumn) {
    const replaced = new Set();

    const walk = (node) => {
        if (!Array.isArray(node)) return node;
        // ["get", "<prop>"] — the only form we repoint. Longer get forms
        // (e.g. ["get", key, obj]) and other operators recurse normally.
        if (node.length === 2 && node[0] === 'get' && typeof node[1] === 'string') {
            const prop = node[1];
            if (prop !== valueColumn && prop !== 'res') {
                replaced.add(prop);
                return ['get', valueColumn];
            }
            return node;
        }
        return node.map(walk);
    };

    return { value: walk(expr), replaced: [...replaced] };
}

/**
 * Build a *flat* `fill-color` expression for a single-resolution hex layer.
 *
 * GeoJSON hex tilesets (server `format: "geojson"`) are materialized at one H3
 * resolution (finest_res) and their features carry only the value columns — no
 * `res` property — so the per-`res` `match` that {@link buildFillColorExpression}
 * emits would render every feature transparent (match fallback). This helper
 * interpolates directly over a single `{min, max}` instead.
 *
 * Null values render transparent; a collapsed range (min == max) renders a flat
 * palette-midpoint color.
 *
 * @param {string} valueColumn - Feature property to color by.
 * @param {{min: number, max: number}} stats - Single-resolution value range.
 * @param {string} palette - One of the keys in PALETTES.
 * @returns {Array} MapLibre expression.
 */
export function buildFlatFillColorExpression(valueColumn, stats, palette) {
    if (!(palette in PALETTES)) {
        throw new Error(`Unknown palette '${palette}'. Valid: ${Object.keys(PALETTES).join(', ')}`);
    }
    if (!stats || stats.min == null || stats.max == null) {
        throw new Error('stats must contain numeric min and max');
    }

    const [c0, c1, c2] = PALETTES[palette];
    const { min, max } = stats;
    const branch = (min < max)
        ? ['interpolate', ['linear'], ['get', valueColumn], min, c0, (min + max) / 2, c1, max, c2]
        : c1;

    return [
        'case',
        ['==', ['get', valueColumn], null],
        'rgba(0,0,0,0)',
        branch,
    ];
}
