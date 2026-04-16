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
