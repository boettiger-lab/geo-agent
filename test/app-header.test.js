// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
    resolveHeaderConfig,
    buildAppHeader,
    CARBON_DASHBOARD_URL,
    DEFAULT_CONTACT,
} from '../app/app-header.js';

const LOGO = { src: 'https://example.org/dse.svg', alt: 'DSE', href: 'https://dse.example.org' };

beforeEach(() => {
    document.body.innerHTML = '';
    document.body.className = '';
    document.documentElement.style.removeProperty('--app-header-h');
});

describe('resolveHeaderConfig', () => {
    it('is on by default — every app in the fleet carries the DSE mark', () => {
        expect(resolveHeaderConfig({}).enabled).toBe(true);
        expect(resolveHeaderConfig().enabled).toBe(true);
    });

    it('can be opted out of explicitly', () => {
        expect(resolveHeaderConfig({ header: { enabled: false } }).enabled).toBe(false);
    });

    it('supplies the DSE mark when no trailing logo is configured', () => {
        const { partner } = resolveHeaderConfig({});
        expect(partner).toHaveLength(1);
        expect(partner[0].src).toContain('dse-mark.png');
        expect(partner[0].srcDark).toContain('dse-mark-white.png');
        expect(partner[0].href).toBe('https://dse.berkeley.edu/');
        expect(partner[0].alt).toBeTruthy();
    });

    it('resolves the mark against the library URL, not the app page', () => {
        // The app's own page is served from somewhere else entirely, so a
        // relative path would not resolve; this must be absolute.
        const { partner } = resolveHeaderConfig({});
        expect(partner[0].src).toMatch(/^[a-z]+:\/\//);
    });

    it('an explicit empty list clears the default mark', () => {
        expect(resolveHeaderConfig({ header: { partner: [] } }).partner).toEqual([]);
        expect(resolveHeaderConfig({ header: { partner: null } }).partner).toEqual([]);
    });

    it('defaults to solid mode and rejects unknown modes', () => {
        // Solid by default: a scrim against the browser's own chrome reads as
        // part of it rather than as the app's bar.
        expect(resolveHeaderConfig({ header: { enabled: true } }).mode).toBe('solid');
        expect(resolveHeaderConfig({ header: { enabled: true, mode: 'scrim' } }).mode).toBe('scrim');
        expect(resolveHeaderConfig({ header: { enabled: true, mode: 'wat' } }).mode).toBe('solid');
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
        expect(cfg.partner).toHaveLength(1);
        expect(cfg.partner[0]).toMatchObject({ src: LOGO.src, alt: 'DSE', href: LOGO.href });
    });

    describe('nav resolution', () => {
        it('derives About / GitHub / Carbon from the existing links block', () => {
            const cfg = resolveHeaderConfig({
                header: { enabled: true },
                links: { docs: 'https://d.example', github: 'https://g.example', carbon: true },
            });
            expect(cfg.nav.map(n => n.label)).toEqual(['About', 'GitHub', 'Carbon', 'Contact us']);
            expect(cfg.nav[0].href).toBe('https://d.example');
            expect(cfg.nav[2].href).toBe(CARBON_DASHBOARD_URL);
            // The carbon entry is marked by its icon, not by a colour — a
            // single recoloured nav item reads as a different kind of link.
            expect(cfg.nav[2].icon).toBe('leaf');
            expect(cfg.nav[2].variant).toBeNull();
            expect(cfg.nav[1].icon).toBe('github');
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
            expect(cfg.nav.map(n => n.label)).toEqual(['GitHub', 'Contact us']);
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

        it('still offers Contact when there is no links block at all', () => {
            const nav = resolveHeaderConfig({ header: { enabled: true } }).nav;
            expect(nav.map(n => n.label)).toEqual(['Contact us']);
            expect(nav[0].href).toBe(DEFAULT_CONTACT);
        });

        it('normalises a bare address to a mailto', () => {
            const cfg = resolveHeaderConfig({
                header: { enabled: true }, links: { contact: 'team@example.org' },
            });
            expect(cfg.nav.at(-1).href).toBe('mailto:team@example.org');
        });

        it('passes a full URL through untouched', () => {
            const cfg = resolveHeaderConfig({
                header: { enabled: true }, links: { contact: 'https://example.org/contact' },
            });
            expect(cfg.nav.at(-1).href).toBe('https://example.org/contact');
        });

        it('keeps a mailto in the same tab, so no blank one is left behind', () => {
            const cfg = resolveHeaderConfig({ header: { enabled: true } });
            expect(cfg.nav.at(-1).external).toBe(false);
        });

        it('drops Contact when explicitly disabled', () => {
            const cfg = resolveHeaderConfig({
                header: { enabled: true }, links: { contact: false },
            });
            expect(cfg.nav).toEqual([]);
        });
    });
});

describe('buildAppHeader', () => {
    it('renders nothing and zeroes the height when disabled', () => {
        const res = buildAppHeader({ header: { enabled: false } }, document);
        expect(res.element).toBeNull();
        expect(res.absorbsLinks).toBe(false);
        expect(document.getElementById('app-header')).toBeNull();
        expect(document.body.classList.contains('has-app-header')).toBe(false);
        // Without .has-app-header the stylesheet's own `--app-header-h: 0px`
        // stands, so the disabled case sets no inline height at all.
        expect(document.documentElement.style.getPropertyValue('--app-header-base-h')).toBe('');
    });

    it('publishes its base height so the sidebar can sit below it', () => {
        // CSS adds env(safe-area-inset-top) to this to get --app-header-h.
        buildAppHeader({ header: { enabled: true } }, document);
        expect(document.documentElement.style.getPropertyValue('--app-header-base-h')).toBe('64px');
        expect(document.body.classList.contains('has-app-header')).toBe(true);
    });

    it('marks solid mode on the body so the map can offset', () => {
        buildAppHeader({ header: { enabled: true } }, document);
        expect(document.body.classList.contains('app-header-solid')).toBe(true);
        expect(document.getElementById('app-header').dataset.mode).toBe('solid');
    });

    it('does not mark the body solid in scrim mode', () => {
        buildAppHeader({ header: { enabled: true, mode: 'scrim' } }, document);
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

    it('renders the default DSE mark when nothing is configured', () => {
        buildAppHeader({}, document);
        const img = document.querySelector('.app-header-logo--light');
        expect(img.src).toContain('dse-mark.png');
        expect(img.closest('a').href).toBe('https://dse.berkeley.edu/');
    });

    it('renders several trailing logos in order', () => {
        // A deployment often carries a partner mark and the institution
        // hosting it, both at the end of the bar.
        buildAppHeader({
            header: {
                enabled: true,
                partner: [
                    { src: 'partner.svg', alt: 'Partner' },
                    { src: 'dse.svg', alt: 'DSE', href: 'https://dse.berkeley.edu/' },
                ],
            },
        }, document);

        const imgs = [...document.querySelectorAll('.app-header-logo--partner')];
        expect(imgs.map(i => i.alt)).toEqual(['Partner', 'DSE']);
        expect(imgs[1].closest('a').href).toBe('https://dse.berkeley.edu/');
    });

    it('drops malformed entries from a logo list', () => {
        buildAppHeader({
            header: { enabled: true, partner: [{ alt: 'no src' }, { src: 'ok.svg', alt: 'Ok' }] },
        }, document);
        const imgs = [...document.querySelectorAll('.app-header-logo--partner')];
        expect(imgs.map(i => i.alt)).toEqual(['Ok']);
    });

    it('reports that it absorbed the links when it renders a nav', () => {
        const res = buildAppHeader({
            header: { enabled: true },
            links: { github: 'https://g.example' },
        }, document);
        expect(res.absorbsLinks).toBe(true);
        // GitHub + the default Contact entry.
        expect(document.querySelectorAll('#app-header-nav a')).toHaveLength(2);
    });

    it('absorbs nothing when there is no nav to show', () => {
        const res = buildAppHeader(
            { header: { enabled: true, title: 'X' }, links: { contact: false } }, document);
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
            // About + GitHub + Contact.
            expect(document.querySelectorAll('.app-header-menu-link')).toHaveLength(3);
        });

        it('closes on Escape', () => {
            build();
            const btn = document.getElementById('app-header-menu-btn');
            const panel = document.getElementById('app-header-menu');
            btn.click();
            panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            expect(panel.hidden).toBe(true);
        });

        it('returns focus to the button it was opened from', () => {
            build();
            const btn = document.getElementById('app-header-menu-btn');
            btn.click();
            document.querySelector('.app-header-menu-close').click();
            expect(document.activeElement).toBe(btn);
        });

        it('is a labelled modal dialog', () => {
            build();
            const panel = document.getElementById('app-header-menu');
            expect(panel.getAttribute('role')).toBe('dialog');
            expect(panel.getAttribute('aria-modal')).toBe('true');
            expect(panel.getAttribute('aria-label')).toBeTruthy();
        });
    });
});

describe('nav icons', () => {
    beforeEach(() => { document.body.innerHTML = ''; document.body.className = ''; });

    it('renders the icon beside the label, not instead of it', () => {
        buildAppHeader({
            header: { enabled: true },
            links: { github: 'https://g.example', carbon: true, contact: false },
        }, document);

        const links = [...document.querySelectorAll('#app-header-nav a')];
        expect(links.map(a => a.textContent.trim())).toEqual(['GitHub', 'Carbon']);
        for (const a of links) {
            expect(a.querySelector('.app-header-link-icon svg')).toBeTruthy();
        }
    });

    it('hides icons from assistive tech, since the label already says it', () => {
        buildAppHeader({
            header: { enabled: true }, links: { github: 'https://g.example', contact: false },
        }, document);
        const svg = document.querySelector('#app-header-nav svg');
        expect(svg.getAttribute('aria-hidden')).toBe('true');
        expect(svg.getAttribute('focusable')).toBe('false');
    });

    it('leaves entries without an icon as plain labels', () => {
        buildAppHeader({ header: { enabled: true } }, document);   // Contact only
        const a = document.querySelector('#app-header-nav a');
        expect(a.textContent.trim()).toBe('Contact us');
        expect(a.querySelector('svg')).toBeNull();
    });

    it('ignores an unknown icon name from config', () => {
        buildAppHeader({
            header: { enabled: true, nav: [{ label: 'X', href: 'https://x.example', icon: 'nope' }] },
        }, document);
        expect(document.querySelector('#app-header-nav svg')).toBeNull();
    });
});
