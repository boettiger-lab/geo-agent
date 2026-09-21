// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
    resolveHeaderConfig,
    buildAppHeader,
    CARBON_DASHBOARD_URL,
} from '../app/app-header.js';

const LOGO = { src: 'https://example.org/dse.svg', alt: 'DSE', href: 'https://dse.example.org' };

beforeEach(() => {
    document.body.innerHTML = '';
    document.body.className = '';
    document.documentElement.style.removeProperty('--app-header-h');
});

describe('resolveHeaderConfig', () => {
    it('is disabled when there is no header block', () => {
        expect(resolveHeaderConfig({}).enabled).toBe(false);
        expect(resolveHeaderConfig().enabled).toBe(false);
    });

    it('defaults to scrim mode and rejects unknown modes', () => {
        expect(resolveHeaderConfig({ header: { enabled: true } }).mode).toBe('scrim');
        expect(resolveHeaderConfig({ header: { enabled: true, mode: 'solid' } }).mode).toBe('solid');
        expect(resolveHeaderConfig({ header: { enabled: true, mode: 'wat' } }).mode).toBe('scrim');
    });

    it('falls back to the sidebar title when the header sets none', () => {
        const cfg = resolveHeaderConfig({
            header: { enabled: true },
            sidebar: { title: 'Protected Areas' },
        });
        expect(cfg.title).toBe('Protected Areas');
    });

    it('prefers an explicit header title over the sidebar title', () => {
        const cfg = resolveHeaderConfig({
            header: { enabled: true, title: 'Explorer' },
            sidebar: { title: 'Protected Areas' },
        });
        expect(cfg.title).toBe('Explorer');
    });

    it('drops a logo with no src rather than rendering a broken image', () => {
        const cfg = resolveHeaderConfig({
            header: { enabled: true, brand: { alt: 'DSE' }, partner: LOGO },
        });
        expect(cfg.brand).toBeNull();
        expect(cfg.partner).toMatchObject({ src: LOGO.src, alt: 'DSE', href: LOGO.href });
    });

    describe('nav resolution', () => {
        it('derives About / GitHub / Carbon from the existing links block', () => {
            const cfg = resolveHeaderConfig({
                header: { enabled: true },
                links: { docs: 'https://d.example', github: 'https://g.example', carbon: true },
            });
            expect(cfg.nav.map(n => n.label)).toEqual(['About', 'GitHub', 'Carbon']);
            expect(cfg.nav[0].href).toBe('https://d.example');
            expect(cfg.nav[2].href).toBe(CARBON_DASHBOARD_URL);
            expect(cfg.nav[2].variant).toBe('carbon');
        });

        it('lets carbon be a string to override the default dashboard', () => {
            const cfg = resolveHeaderConfig({
                header: { enabled: true },
                links: { carbon: 'https://carbon.example' },
            });
            expect(cfg.nav[0].href).toBe('https://carbon.example');
        });

        it('omits links that are not configured', () => {
            const cfg = resolveHeaderConfig({
                header: { enabled: true },
                links: { github: 'https://g.example' },
            });
            expect(cfg.nav.map(n => n.label)).toEqual(['GitHub']);
        });

        it('an explicit nav wins over the derived one', () => {
            const cfg = resolveHeaderConfig({
                header: { enabled: true, nav: [{ label: 'Methods', href: 'https://m.example' }] },
                links: { docs: 'https://d.example', github: 'https://g.example' },
            });
            expect(cfg.nav.map(n => n.label)).toEqual(['Methods']);
        });

        it('an explicit empty nav suppresses the derived one', () => {
            const cfg = resolveHeaderConfig({
                header: { enabled: true, nav: [] },
                links: { docs: 'https://d.example' },
            });
            expect(cfg.nav).toEqual([]);
        });

        it('skips malformed nav entries', () => {
            const cfg = resolveHeaderConfig({
                header: {
                    enabled: true,
                    nav: [{ label: 'Ok', href: 'https://o.example' }, { label: 'No href' }, null],
                },
            });
            expect(cfg.nav.map(n => n.label)).toEqual(['Ok']);
        });

        it('is empty when there is neither a nav nor a links block', () => {
            expect(resolveHeaderConfig({ header: { enabled: true } }).nav).toEqual([]);
        });
    });
});

describe('buildAppHeader', () => {
    it('renders nothing and zeroes the height when disabled', () => {
        const res = buildAppHeader({}, document);
        expect(res.element).toBeNull();
        expect(res.absorbsLinks).toBe(false);
        expect(document.getElementById('app-header')).toBeNull();
        expect(document.body.classList.contains('has-app-header')).toBe(false);
        // Other rules read this unconditionally, so it must be a usable length.
        expect(document.documentElement.style.getPropertyValue('--app-header-h')).toBe('0px');
    });

    it('publishes its height so the sidebar can sit below it', () => {
        buildAppHeader({ header: { enabled: true } }, document);
        expect(document.documentElement.style.getPropertyValue('--app-header-h')).toBe('56px');
        expect(document.body.classList.contains('has-app-header')).toBe(true);
    });

    it('marks solid mode on the body so the map can offset', () => {
        buildAppHeader({ header: { enabled: true, mode: 'solid' } }, document);
        expect(document.body.classList.contains('app-header-solid')).toBe(true);
        expect(document.getElementById('app-header').dataset.mode).toBe('solid');
    });

    it('does not mark the body solid in scrim mode', () => {
        buildAppHeader({ header: { enabled: true } }, document);
        expect(document.body.classList.contains('app-header-solid')).toBe(false);
    });

    it('wraps a logo in a link only when a href is given', () => {
        buildAppHeader({
            header: { enabled: true, brand: LOGO, partner: { src: 'p.svg', alt: 'P' } },
        }, document);

        const brandImg = document.querySelector('.app-header-brand img');
        expect(brandImg.closest('a').href).toContain('dse.example.org');
        expect(brandImg.alt).toBe('DSE');

        const partnerImg = document.querySelector('.app-header-logo--partner');
        expect(partnerImg.closest('a')).toBeNull();
    });

    it('reports that it absorbed the links when it renders a nav', () => {
        const res = buildAppHeader({
            header: { enabled: true },
            links: { github: 'https://g.example' },
        }, document);
        expect(res.absorbsLinks).toBe(true);
        expect(document.querySelectorAll('#app-header-nav a')).toHaveLength(1);
    });

    it('absorbs nothing when there is no nav to show', () => {
        const res = buildAppHeader({ header: { enabled: true, title: 'X' } }, document);
        expect(res.absorbsLinks).toBe(false);
        expect(document.getElementById('app-header-nav')).toBeNull();
        // No nav means no menu button either.
        expect(document.getElementById('app-header-menu-btn')).toBeNull();
    });

    it('opens external nav links safely', () => {
        buildAppHeader({
            header: { enabled: true },
            links: { github: 'https://g.example' },
        }, document);
        const a = document.querySelector('#app-header-nav a');
        expect(a.target).toBe('_blank');
        expect(a.rel).toBe('noopener noreferrer');
    });

    it('keeps a same-page nav entry in the tab when external is false', () => {
        buildAppHeader({
            header: {
                enabled: true,
                nav: [{ label: 'Methods', href: '/methods', external: false }],
            },
        }, document);
        const a = document.querySelector('#app-header-nav a');
        expect(a.target).toBe('');
    });

    describe('mobile takeover', () => {
        const build = () => buildAppHeader({
            header: { enabled: true },
            links: { docs: 'https://d.example', github: 'https://g.example' },
        }, document);

        it('starts closed', () => {
            build();
            const panel = document.getElementById('app-header-menu');
            expect(panel.hidden).toBe(true);
            expect(document.getElementById('app-header-menu-btn').getAttribute('aria-expanded'))
                .toBe('false');
        });

        it('toggles open and closed from the button', () => {
            build();
            const btn = document.getElementById('app-header-menu-btn');
            const panel = document.getElementById('app-header-menu');

            btn.click();
            expect(panel.hidden).toBe(false);
            expect(btn.getAttribute('aria-expanded')).toBe('true');

            btn.click();
            expect(panel.hidden).toBe(true);
            expect(btn.getAttribute('aria-expanded')).toBe('false');
        });

        it('closes on the close button', () => {
            build();
            document.getElementById('app-header-menu-btn').click();
            document.querySelector('.app-header-menu-close').click();
            expect(document.getElementById('app-header-menu').hidden).toBe(true);
        });

        it('closes when a link is chosen, so it cannot cover the map', () => {
            build();
            document.getElementById('app-header-menu-btn').click();
            document.querySelector('.app-header-menu-link').click();
            expect(document.getElementById('app-header-menu').hidden).toBe(true);
        });

        it('mirrors every nav entry', () => {
            build();
            expect(document.querySelectorAll('.app-header-menu-link')).toHaveLength(2);
        });
    });
});
