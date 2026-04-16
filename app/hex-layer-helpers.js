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
