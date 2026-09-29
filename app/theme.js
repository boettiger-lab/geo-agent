/**
 * theme.js — chrome colour scheme.
 *
 * The header and the sidebar are one continuous surface (see the `#app-header`
 * rules in style.css), so they have to be coloured together or the seam where
 * they meet shows. This module picks the scheme; the colours themselves live
 * in `style.css` as `--chrome-*` / `--control-*` / `--panel-*` tokens,
 * redefined per theme.
 *
 * Two layers:
 *
 *   1. A **mode** — light, dark or auto — applied as a body class, which
 *      selects a whole palette.
 *   2. Optional **per-app overrides**, applied as inline custom properties on
 *      <body>. Inline beats the stylesheet's `body.theme-*` rules, so an app
 *      can recolour without shipping CSS. They must go on <body> rather than
 *      <html>: the palettes are defined on `body.theme-*`, and a custom
 *      property set there would win over one inherited from :root.
 *
 * Overrides are a small curated set of semantic names, plus a `tokens` escape
 * hatch for anything not covered. Deliberately curated: exposing all ~37
 * tokens as config would make every one of them a compatibility surface.
 *
 * `light` is the default because it is what the sidebar has always been: an
 * app bumping its pin should not silently change colour.
 */

const THEMES = new Set(['light', 'dark', 'auto']);

export const DEFAULT_THEME = 'light';

/**
 * Friendly config names → the custom property each drives.
 *
 * `primary` additionally drives the hover and selected states, derived in CSS
 * with color-mix() against `--control-mix-target`, which each palette sets to
 * the direction that reads as "more pressed" for that mode — darker on light,
 * lighter on dark. Doing it in CSS rather than here is what lets `auto` get it
 * right when the viewer's OS setting changes without a reload.
 */
const COLOR_KEYS = {
    primary:  ['--control-bg', '--control-accent'],
    surface:  ['--chrome-bg'],
    text:     ['--chrome-fg'],
    backdrop: ['--map-void-bg'],
    panel:    ['--panel-bg'],
};

/**
 * Conservative check on a colour value.
 *
 * These strings are written into a style attribute, so they are not free text.
 * A hex / rgb() / hsl() / named colour covers what anyone reasonably wants and
 * excludes `url(...)` and other functional values.
 */
const COLOR_RE = /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([0-9a-z%.,\s/+-]+\)|[a-z]{3,20})$/i;

function isColor(v) {
    return typeof v === 'string' && v.length <= 64 && COLOR_RE.test(v.trim());
}

/**
 * Normalise the `theme` config, which is either a mode string or an object.
 *
 * @param {Object} appConfig
 * @returns {{ mode: 'light'|'dark'|'auto', overrides: Object<string,string> }}
 */
export function resolveTheme(appConfig = {}) {
    const theme = appConfig.theme;

    if (typeof theme === 'string' || theme == null) {
        return { mode: THEMES.has(theme) ? theme : DEFAULT_THEME, overrides: {} };
    }
    if (typeof theme !== 'object') {
        return { mode: DEFAULT_THEME, overrides: {} };
    }

    const mode = THEMES.has(theme.mode) ? theme.mode : DEFAULT_THEME;
    const overrides = {};

    for (const [key, props] of Object.entries(COLOR_KEYS)) {
        const value = theme[key];
        if (!isColor(value)) continue;
        for (const prop of props) overrides[prop] = value.trim();
    }

    // Escape hatch: any token in style.css, for the cases the curated names
    // do not reach. Same colour validation; the name must look like a token.
    if (theme.tokens && typeof theme.tokens === 'object') {
        for (const [name, value] of Object.entries(theme.tokens)) {
            if (!/^--[a-z0-9-]{1,48}$/i.test(name)) continue;
            if (!isColor(value)) continue;
            overrides[name] = value.trim();
        }
    }

    return { mode, overrides };
}

/**
 * Apply the theme: a mode class plus any per-app colour overrides.
 *
 * `auto` is applied as its own class rather than being resolved to light or
 * dark here, so the CSS can follow `prefers-color-scheme` live — a viewer
 * switching their OS to dark mode should not have to reload.
 *
 * @param {Object} appConfig
 * @param {Document} [doc]
 * @returns {{ mode: string, overrides: Object<string,string> }}
 */
export function applyTheme(appConfig, doc = document) {
    const { mode, overrides } = resolveTheme(appConfig);

    const body = doc.body;
    for (const t of THEMES) body.classList.remove(`theme-${t}`);
    body.classList.add(`theme-${mode}`);

    for (const [prop, value] of Object.entries(overrides)) {
        body.style.setProperty(prop, value);
    }

    return { mode, overrides };
}
