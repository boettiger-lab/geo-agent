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
