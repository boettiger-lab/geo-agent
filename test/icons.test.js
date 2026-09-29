import { describe, it, expect } from 'vitest';
import { githubIcon, leafIcon } from '../app/icons.js';

/**
 * These sit inside themed chrome, so they have to follow the text colour.
 * The GitHub mark shipped without a `fill`, which means SVG's default of
 * black — invisible-ish on a dark header while the leaf beside it adapted
 * correctly. Nothing in the markup says "this is wrong", hence the test.
 */
const ICONS = [['githubIcon', githubIcon], ['leafIcon', leafIcon]];

describe.each(ICONS)('%s', (_name, icon) => {
    const svg = icon(14);

    it('takes its colour from the text around it', () => {
        expect(svg).toMatch(/(fill|stroke)="currentColor"/);
    });

    it('hardcodes no colour, which would ignore the theme', () => {
        // `fill="none"` is a shape directive, not a colour, so it is allowed.
        const colours = svg.match(/(fill|stroke)="(?!currentColor|none)[^"]+"/g);
        expect(colours).toBeNull();
    });

    it('is hidden from assistive tech — the label beside it already says it', () => {
        expect(svg).toContain('aria-hidden="true"');
        expect(svg).toContain('focusable="false"');
    });

    it('honours the requested size', () => {
        expect(icon(22)).toContain('width="22"');
        expect(icon(22)).toContain('height="22"');
    });
});
