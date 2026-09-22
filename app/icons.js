/**
 * icons.js — the few inline SVGs shared between the header nav and the chat
 * footer links.
 *
 * They live here rather than inline at each use so the two places cannot
 * drift apart, and so size is a parameter: the footer wants 15–16px, the nav
 * a little smaller beside its label.
 *
 * All are `aria-hidden` and `fill="currentColor"` / `stroke="currentColor"`:
 * each sits next to its own text label, so announcing it again would just be
 * noise, and it should follow whatever colour the link is.
 */

/** GitHub mark. */
export function githubIcon(size = 14) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="${size}" height="${size}" fill="currentColor" aria-hidden="true" focusable="false">${GITHUB_PATH}</svg>`;
}

/** Leaf, for the carbon dashboard. */
export function leafIcon(size = 14) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${LEAF_PATHS}</svg>`;
}

const GITHUB_PATH = `<path fill-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>`;

const LEAF_PATHS = `<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19.2 2.96a1 1 0 0 1 1.8.66c.4 5.85-1.18 12.96-9 16.4"/><path d="M2 21c0-3 1.85-5.36 5.08-6"/>`;
