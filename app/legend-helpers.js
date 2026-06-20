/**
 * Pure helpers for building vector-layer legends.
 *
 * No DOM / MapLibre dependencies, so they're unit-testable without a browser.
 * Consumed by map-manager.js (the continuous-vector legend branch, #258).
 */

/**
 * The paint keys that carry a layer's primary data-driven color, in priority
 * order. A fill layer colors via `fill-color`, a line via `line-color`, a
 * circle via `circle-color`.
 */
const COLOR_PAINT_KEYS = ['fill-color', 'line-color', 'circle-color'];

/**
 * Derive a continuous legend (gradient + value range) from a vector layer's
 * paint, by parsing a data-driven `interpolate` or `step` color expression.
 *
 * Rasters get their colorbar from TiTiler `colormap` + `rescale`; vector layers
 * have neither, but a graduated choropleth already encodes the same information
 * in its paint expression — e.g.
 *   ["interpolate", ["linear"], ["get", "species"], 0, "#edf8e9", 242, "#005a32"]
 * This reads the numeric stops (value axis) and their colors (gradient) back out
 * so the legend can mirror the map without duplicate config.
 *
 * @param {Object} paint - A MapLibre paint object (e.g. layer state `defaultPaint`).
 * @returns {{ gradient: string[], range: [number, number] } | null}
 *   `gradient` is ≥2 CSS color strings low→high; `range` is [min, max] of the
 *   numeric stops. Returns null when no parseable continuous color expression
 *   is present (e.g. a flat color, a `match`/categorical expression, or no paint).
 */
export function deriveContinuousLegend(paint) {
    if (!paint || typeof paint !== 'object') return null;

    let expr = null;
    for (const key of COLOR_PAINT_KEYS) {
        if (Array.isArray(paint[key])) { expr = paint[key]; break; }
    }
    if (!expr) return null;

    const op = expr[0];
    const stops = [];   // { value, color }

    if (op === 'interpolate' || op === 'interpolate-hcl' || op === 'interpolate-lab') {
        // ["interpolate", <interpolation>, <input>, v0, c0, v1, c1, ...]
        for (let i = 3; i + 1 < expr.length; i += 2) {
            const value = expr[i];
            const color = expr[i + 1];
            if (typeof value === 'number' && typeof color === 'string') {
                stops.push({ value, color });
            }
        }
    } else if (op === 'step') {
        // ["step", <input>, c0, v1, c1, v2, c2, ...]
        // c0 is the color below the first threshold; subsequent pairs are
        // (threshold, color). Use the thresholds as the value axis.
        if (typeof expr[2] === 'string') stops.push({ value: null, color: expr[2] });
        for (let i = 3; i + 1 < expr.length; i += 2) {
            const value = expr[i];
            const color = expr[i + 1];
            if (typeof value === 'number' && typeof color === 'string') {
                stops.push({ value, color });
            }
        }
    } else {
        return null;
    }

    const colors = stops.map(s => s.color);
    const values = stops.map(s => s.value).filter(v => typeof v === 'number');
    if (colors.length < 2 || values.length < 1) return null;

    return {
        gradient: colors,
        range: [Math.min(...values), Math.max(...values)],
    };
}
