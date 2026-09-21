/**
 * theme.js — chrome colour scheme.
 *
 * The header and the sidebar are one continuous surface (see the `#app-header`
 * rules in style.css), so they have to be coloured together or the seam where
 * they meet shows. This module picks the scheme; the colours themselves live
 * in `style.css` as `--chrome-*` tokens, redefined per theme.
 *
 * Scope is deliberately the chrome *shell* — header, sidebar surface, footer,
 * hairlines, the map backdrop behind a globe. The chat interior (message
 * bubbles, tool-call blocks, syntax highlighting) still carries its own
 * colours in chat.css and is not themed yet.
 *
 * `light` is the default because it is what the sidebar has always been: an
 * app bumping its pin should not silently change colour.
 */

const THEMES = new Set(['light', 'dark', 'auto']);

export const DEFAULT_THEME = 'light';

/**
 * Resolve the configured theme, falling back for anything unrecognised.
 *
 * @param {Object} appConfig
 * @returns {'light'|'dark'|'auto'}
 */
export function resolveTheme(appConfig = {}) {
    const theme = appConfig.theme;
    return THEMES.has(theme) ? theme : DEFAULT_THEME;
}

/**
 * Apply the theme as a body class.
 *
 * `auto` is applied as its own class rather than being resolved to light or
 * dark here, so the CSS can follow `prefers-color-scheme` live — a viewer
 * switching their OS to dark mode should not have to reload.
 *
 * @param {Object} appConfig
 * @param {Document} [doc]
 * @returns {string} the applied theme
 */
export function applyTheme(appConfig, doc = document) {
    const theme = resolveTheme(appConfig);
    const body = doc.body;
    for (const t of THEMES) body.classList.remove(`theme-${t}`);
    body.classList.add(`theme-${theme}`);
    return theme;
}
