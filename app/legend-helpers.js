/**
 * Pure helpers for building vector-layer legends.
 *
 * No DOM / MapLibre dependencies, so they're unit-testable without a browser.
 * Consumed by map-manager.js (the continuous-vector legend branch, #258).
 */

/**
 * The paint keys that carry a layer's primary data-driven color, in priority
 * order. A fill layer colors via `fill-color`, an extruded fill via
 * `fill-extrusion-color` (3D hex layers, #317), a line via `line-color`, a
 * circle via `circle-color`.
 */
export const COLOR_PAINT_KEYS = ['fill-color', 'fill-extrusion-color', 'line-color', 'circle-color'];

/**
 * The paint object's primary color value — expression *or* literal — so callers
 * can tell whether a restyle replaced the color a legend was derived from
 * (#333). Unlike {@link deriveContinuousLegend} this doesn't skip past a flat
 * color to find an expression: "the color this layer paints with" is the first
 * color key present, whatever its form.
 *
 * @param {Object} paint - A MapLibre paint object.
 * @returns {*} The color value, or undefined when the paint carries none.
 */
export function primaryColorValue(paint) {
    if (!paint || typeof paint !== 'object') return undefined;
    for (const key of COLOR_PAINT_KEYS) {
        if (paint[key] !== undefined) return paint[key];
    }
    return undefined;
}

/**
 * Derive a discrete legend (one swatch per category) from a vector layer's
 * paint, by parsing a data-driven `match` color expression.
 *
 * The categorical counterpart to {@link deriveContinuousLegend}. An agent that
 * codes categories as integers in SQL and recolors with `match` produces a map
 * whose colors are discrete, and a continuous colorbar over the code range
 * describes it wrongly (#334). The value→color pairs are already in the paint;
 * this reads them back out so the legend mirrors the map.
 *
 * Only `match` qualifies. `step` is a numeric ramp binned into classes and is
 * already handled as continuous, and `case` carries arbitrary predicates with
 * no value to label a swatch with.
 *
 * @param {Object} paint - A MapLibre paint object.
 * @returns {{ classes: Array<{ value: *, color: string }> } | null}
 *   One entry per `match` label, in expression order. Returns null when the
 *   primary color is not a flat `match` over scalar labels — including the
 *   `case`-wrapped per-resolution expression hex layers register with, whose
 *   `match` arms are nested expressions rather than colors.
 */
export function deriveCategoricalLegend(paint) {
    if (!paint || typeof paint !== 'object') return null;

    let expr = null;
    for (const key of COLOR_PAINT_KEYS) {
        if (Array.isArray(paint[key])) { expr = paint[key]; break; }
    }
    if (!expr || expr[0] !== 'match') return null;

    // ["match", <input>, label0, color0, label1, color1, ..., <fallback>]
    // Pairs start at index 2; the trailing lone element is the fallback color,
    // which the loop bound excludes. The fallback gets no swatch on purpose —
    // it stands for "everything not enumerated", which commonly matches no
    // feature at all, and a legend row for it would claim a category the map
    // may not contain.
    const classes = [];
    const isScalar = v => typeof v === 'number' || typeof v === 'string';
    for (let i = 2; i + 1 < expr.length; i += 2) {
        const value = expr[i];
        const color = expr[i + 1];
        // Bail on the whole expression rather than skipping arms: a partial
        // swatch list is a legend that silently omits colors that are on screen.
        if (typeof color !== 'string') return null;
        // A label may be one value or an array of values sharing a color.
        if (Array.isArray(value) ? value.length > 0 && value.every(isScalar) : isScalar(value)) {
            classes.push({ value, color });
        } else {
            return null;
        }
    }
    if (classes.length === 0) return null;

    return { classes };
}

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
