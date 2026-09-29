// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { resolveTheme, applyTheme, DEFAULT_THEME } from '../app/theme.js';

beforeEach(() => {
    document.body.className = '';
    document.body.removeAttribute('style');
});

describe('resolveTheme', () => {
    it('defaults to light, which is what the sidebar has always been', () => {
        expect(DEFAULT_THEME).toBe('light');
        expect(resolveTheme({}).mode).toBe('light');
        expect(resolveTheme().mode).toBe('light');
    });

    it('accepts the three modes as a bare string', () => {
        for (const t of ['light', 'dark', 'auto']) {
            expect(resolveTheme({ theme: t })).toEqual({ mode: t, overrides: {} });
        }
    });

    it('falls back rather than applying an unknown mode', () => {
        expect(resolveTheme({ theme: 'solarized' }).mode).toBe('light');
        expect(resolveTheme({ theme: null }).mode).toBe('light');
        expect(resolveTheme({ theme: 42 }).mode).toBe('light');
    });

    it('accepts the object form and keeps the mode', () => {
        expect(resolveTheme({ theme: { mode: 'dark' } }).mode).toBe('dark');
    });

    describe('colour overrides', () => {
        it('maps friendly names onto tokens', () => {
            const { overrides } = resolveTheme({
                theme: { mode: 'dark', primary: '#7a5cff', surface: '#1b1533', text: '#f2edff' },
            });
            expect(overrides['--control-bg']).toBe('#7a5cff');
            expect(overrides['--chrome-bg']).toBe('#1b1533');
            expect(overrides['--chrome-fg']).toBe('#f2edff');
        });

        it('drives the accent from primary, so one knob recolours the set', () => {
            const { overrides } = resolveTheme({ theme: { primary: '#7a5cff' } });
            expect(overrides['--control-accent']).toBe('#7a5cff');
            // Hover and selected are derived in CSS via color-mix, so they are
            // deliberately absent here.
            expect(overrides['--control-bg-hover']).toBeUndefined();
        });

        it('accepts rgb/hsl/named colours, not just hex', () => {
            const { overrides } = resolveTheme({
                theme: { primary: 'rgb(122, 92, 255)', surface: 'hsl(250 40% 15%)', text: 'white' },
            });
            expect(overrides['--control-bg']).toBe('rgb(122, 92, 255)');
            expect(overrides['--chrome-bg']).toBe('hsl(250 40% 15%)');
            expect(overrides['--chrome-fg']).toBe('white');
        });

        it('rejects values that are not colours', () => {
            // These land in a style attribute, so anything functional that is
            // not a colour stays out.
            const { overrides } = resolveTheme({
                theme: {
                    primary: 'url(https://evil.example/x.png)',
                    surface: 'red; position: fixed',
                    text: '',
                    backdrop: 123,
                },
            });
            expect(overrides).toEqual({});
        });

        it('takes arbitrary tokens through the escape hatch', () => {
            const { overrides } = resolveTheme({
                theme: { tokens: { '--panel-fg-muted': '#889', '--chat-code-bg': '#222' } },
            });
            expect(overrides['--panel-fg-muted']).toBe('#889');
            expect(overrides['--chat-code-bg']).toBe('#222');
        });

        it('ignores escape-hatch entries that are not token names', () => {
            const { overrides } = resolveTheme({
                theme: { tokens: { 'color': 'red', '--ok': '#fff', 'background:x': '#fff' } },
            });
            expect(overrides).toEqual({ '--ok': '#fff' });
        });

        it('has no overrides for the plain string form', () => {
            expect(resolveTheme({ theme: 'dark' }).overrides).toEqual({});
        });
    });
});

describe('applyTheme', () => {
    it('sets the mode class on the body', () => {
        expect(applyTheme({ theme: 'dark' }, document).mode).toBe('dark');
        expect(document.body.classList.contains('theme-dark')).toBe(true);
    });

    it('leaves auto as its own class so CSS can follow the OS live', () => {
        // Resolving auto here would freeze the choice at boot, so a viewer
        // switching their OS to dark mode would have to reload.
        applyTheme({ theme: 'auto' }, document);
        expect(document.body.classList.contains('theme-auto')).toBe(true);
        expect(document.body.classList.contains('theme-light')).toBe(false);
    });

    it('replaces a previously applied mode rather than stacking', () => {
        applyTheme({ theme: 'dark' }, document);
        applyTheme({ theme: 'light' }, document);
        expect(document.body.classList.contains('theme-dark')).toBe(false);
        expect(document.body.classList.contains('theme-light')).toBe(true);
    });

    it('writes overrides inline on the body so they beat the palette rules', () => {
        // The palettes are defined on `body.theme-*`; an override on <html>
        // would be inherited and lose to them.
        applyTheme({ theme: { mode: 'dark', primary: '#7a5cff' } }, document);
        expect(document.body.style.getPropertyValue('--control-bg')).toBe('#7a5cff');
        expect(document.body.style.getPropertyValue('--control-accent')).toBe('#7a5cff');
    });

    it('writes nothing inline when no overrides are configured', () => {
        applyTheme({ theme: 'dark' }, document);
        expect(document.body.getAttribute('style')).toBeFalsy();
    });

    it('applies the default when nothing is configured', () => {
        applyTheme({}, document);
        expect(document.body.classList.contains('theme-light')).toBe(true);
    });
});
