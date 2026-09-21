// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { resolveTheme, applyTheme, DEFAULT_THEME } from '../app/theme.js';

beforeEach(() => { document.body.className = ''; });

describe('resolveTheme', () => {
    it('defaults to light, which is what the sidebar has always been', () => {
        expect(DEFAULT_THEME).toBe('light');
        expect(resolveTheme({})).toBe('light');
        expect(resolveTheme()).toBe('light');
    });

    it('accepts the three supported values', () => {
        for (const t of ['light', 'dark', 'auto']) {
            expect(resolveTheme({ theme: t })).toBe(t);
        }
    });

    it('falls back rather than applying an unknown theme', () => {
        expect(resolveTheme({ theme: 'solarized' })).toBe('light');
        expect(resolveTheme({ theme: null })).toBe('light');
    });
});

describe('applyTheme', () => {
    it('sets the theme class on the body', () => {
        expect(applyTheme({ theme: 'dark' }, document)).toBe('dark');
        expect(document.body.classList.contains('theme-dark')).toBe(true);
    });

    it('leaves auto as its own class so CSS can follow the OS live', () => {
        // Resolving auto here would freeze the choice at boot, so a viewer
        // switching their OS to dark mode would have to reload.
        applyTheme({ theme: 'auto' }, document);
        expect(document.body.classList.contains('theme-auto')).toBe(true);
        expect(document.body.classList.contains('theme-light')).toBe(false);
        expect(document.body.classList.contains('theme-dark')).toBe(false);
    });

    it('replaces a previously applied theme rather than stacking', () => {
        applyTheme({ theme: 'dark' }, document);
        applyTheme({ theme: 'light' }, document);
        expect(document.body.classList.contains('theme-dark')).toBe(false);
        expect(document.body.classList.contains('theme-light')).toBe(true);
    });

    it('applies the default when nothing is configured', () => {
        applyTheme({}, document);
        expect(document.body.classList.contains('theme-light')).toBe(true);
    });
});
