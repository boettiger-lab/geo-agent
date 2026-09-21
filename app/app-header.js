/**
 * app-header.js — the app chrome band across the top of the page.
 *
 * This is the "app chrome" half of the split described in #363: things that
 * are true of the *deployment* (who made it, what else there is to read) live
 * here, and things that are true of the *current map state* (legend, sliders,
 * hex controls) live on the map surface, in the overlay rail. That split is
 * the placement rule the layout previously lacked — before it, a new control
 * went wherever there happened to be room.
 *
 * Two visual modes, one component:
 *
 *   - `scrim` (default) — a translucent band over a full-bleed map. The map
 *     keeps the whole viewport; the header costs no vertical space.
 *   - `solid` — an opaque band that the map starts below.
 *
 * Having both means adopting a header does not force the "do we give up ~56px
 * of map?" question to be answered up front, and a future content route can
 * use the solid treatment without a second component.
 *
 * Opt-in. With no `header` config there is no band, `--app-header-h` stays
 * `0px`, and nothing about the existing layout changes — so a downstream app
 * bumping its pin does not suddenly grow chrome it never asked for.
 *
 * Logos are supplied by config as URLs; this module ships no image assets.
 */

import { githubIcon, leafIcon } from './icons.js';

/** Carbon dashboard for NRP-hosted LLM usage, shown as a nav entry. */
export const CARBON_DASHBOARD_URL = 'https://carbon-api.nrp-nautilus.io/';

/** Where "Contact us" goes when an app does not say otherwise. */
export const DEFAULT_CONTACT = 'mailto:dse@berkeley.edu';

/**
 * The DSE mark every app in the fleet carries, resolved against this module's
 * own URL.
 *
 * import.meta.url is the jsDelivr path the app loaded the library from, so the
 * asset comes from the same pinned ref and needs no configuration — an app's
 * own page is served from somewhere else entirely, so a relative path would
 * not resolve.
 */
export function defaultTrailingLogo() {
    const asset = name => new URL(`./assets/${name}`, import.meta.url).href;
    return {
        src: asset('dse-mark.png'),
        src_dark: asset('dse-mark-white.png'),
        alt: 'Eric and Wendy Schmidt Center for Data Science & Environment at Berkeley',
        href: 'https://dse.berkeley.edu/',
    };
}

/**
 * Height of the band, before any device safe-area inset.
 *
 * Published as `--app-header-base-h`; CSS adds `env(safe-area-inset-top)` on
 * top and exposes the total as `--app-header-h`, which is what everything
 * below the band reads.
 */
const HEADER_BASE_HEIGHT_PX = 64;

/**
 * `solid` is the default: a translucent scrim sits directly against the
 * browser's own chrome and reads as part of it rather than as the app's bar.
 * `scrim` stays available for a full-bleed map where the band must not cost
 * any map area.
 */
const MODES = new Set(['scrim', 'solid']);
const DEFAULT_MODE = 'solid';

/**
 * Resolve the `header` config block into the model the DOM builder renders.
 *
 * Pure, and exported for tests: the interesting behaviour is which nav entries
 * appear and where they came from, not the markup.
 *
 * Nav resolution has three tiers, so an app that already has a `links` block
 * gets a sensible nav without configuring anything twice:
 *   1. `header.nav` — an explicit list wins outright.
 *   2. otherwise, derive from the top-level `links` block (About / GitHub /
 *      Carbon), which is where those links live today.
 *   3. otherwise, no nav.
 *
 * @param {Object} appConfig — the merged app config
 * @returns {{
 *   enabled: boolean, mode: string, title: string|null,
 *   brand: Object|null, partner: Object|null, nav: Array<Object>,
 * }}
 */
export function resolveHeaderConfig(appConfig = {}) {
    const header = appConfig.header || {};
    // On by default across the fleet: every app carries the DSE mark. Opt out
    // with `header: { enabled: false }`.
    const enabled = header.enabled !== false;

    const mode = MODES.has(header.mode) ? header.mode : DEFAULT_MODE;

    return {
        enabled,
        mode,
        title: header.title || appConfig.sidebar?.title || null,
        brand: normalizeLogo(header.brand),
        // Unset means the default DSE mark; an explicit [] or null means the
        // app has deliberately cleared it.
        partner: normalizeLogoList(
            header.partner === undefined ? defaultTrailingLogo() : header.partner,
        ),
        nav: resolveNav(header, appConfig.links),
    };
}

/**
 * Schemes a config may put behind a link or a logo.
 *
 * Config is first-party — it comes from the app's own layers-input.json, not
 * from anything a visitor supplies — so this is defence in depth rather than
 * a boundary. But `javascript:` in an href is a footgun worth closing at the
 * point where config becomes DOM, and a config file is exactly the kind of
 * thing that gets templated, generated, or pasted from elsewhere.
 *
 * Relative and root-relative paths are allowed: an app may reasonably link to
 * its own routes.
 */
const SAFE_SCHEME = /^(https?:|mailto:|tel:)/i;

function safeHref(value) {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    if (!v) return null;
    if (SAFE_SCHEME.test(v)) return v;
    // No scheme at all — a path, query or fragment on the app's own origin.
    if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return null;
    return v;
}

/**
 * Resolve the contact target, accepting a bare address for convenience.
 *
 * A config that says `"contact": "team@example.org"` means mail, not a
 * relative path, so it is normalised rather than left to 404.
 */
function contactHref(value) {
    if (typeof value !== 'string' || !value.trim()) return DEFAULT_CONTACT;
    const v = value.trim();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return `mailto:${v}`;
    return v;
}

/**
 * Trailing logos, as a list.
 *
 * Accepts a single object or an array, because a deployment often carries
 * more than one mark at the end of the bar — a partner alongside the
 * institution that hosts it. Entries without a `src` are dropped.
 *
 * @returns {Array<Object>}
 */
function normalizeLogoList(value) {
    const items = Array.isArray(value) ? value : [value];
    return items.map(normalizeLogo).filter(Boolean);
}

/**
 * A logo entry needs a `src` to be renderable; anything without one is
 * dropped rather than rendered as a broken image.
 */
function normalizeLogo(logo) {
    if (!logo || typeof logo !== 'object' || !logo.src) return null;
    return {
        src: logo.src,
        // Optional variant for the dark theme. A logo is an image and cannot
        // follow the palette, so a mark drawn for one background disappears
        // on the other; supplying both is the only real fix.
        srcDark: logo.src_dark || null,
        alt: logo.alt || '',
        href: safeHref(logo.href),
    };
}

function resolveNav(header, links) {
    if (Array.isArray(header.nav)) {
        return header.nav
            .filter(item => item && item.label && safeHref(item.href))
            .map(item => ({
                label: String(item.label),
                href: safeHref(item.href),
                variant: item.variant || null,
                icon: ICONS[item.icon] ? item.icon : null,
                external: item.external !== false,
            }));
    }

    const l = links || {};

    // Mirror the order the footer has used — About, GitHub, Carbon — then
    // Contact, which is the one entry that appears by default rather than
    // only when configured. Set `links.contact` to false to drop it.
    const derived = [];
    if (l.docs) derived.push({ label: 'About', href: safeHref(l.docs) });
    if (l.github) derived.push({ label: 'GitHub', href: safeHref(l.github), icon: 'github' });
    if (l.carbon) {
        derived.push({
            label: 'Carbon',
            href: safeHref(typeof l.carbon === 'string' ? l.carbon : CARBON_DASHBOARD_URL),
            icon: 'leaf',
        });
    }
    if (l.contact !== false) {
        derived.push({
            label: 'Contact us',
            href: safeHref(contactHref(l.contact)),
            // A mailto: opens a mail client, so a new tab would leave a blank
            // one behind.
            external: false,
        });
    }
    return derived
        .map(item => ({ variant: null, icon: null, external: true, ...item }))
        .filter(item => item.href);
}

/**
 * Build the header and attach it to the document.
 *
 * Safe to call unconditionally: with the header disabled it sets
 * `--app-header-h: 0px`, adds no element, and reports that it absorbed
 * nothing, so callers need no branching.
 *
 * @param {Object} appConfig
 * @param {Document} [doc]
 * @returns {{ element: HTMLElement|null, absorbsLinks: boolean, height: number }}
 */
export function buildAppHeader(appConfig, doc = document) {
    const cfg = resolveHeaderConfig(appConfig);

    if (!cfg.enabled) {
        return { element: null, absorbsLinks: false, height: 0 };
    }

    doc.documentElement.style.setProperty('--app-header-base-h', HEADER_BASE_HEIGHT_PX + 'px');
    doc.body.classList.add('has-app-header');
    if (cfg.mode === 'solid') doc.body.classList.add('app-header-solid');

    const header = el(doc, 'header', { id: 'app-header', 'data-mode': cfg.mode });

    /* ----- Brand zone: logos + app title ----- */
    const brandZone = el(doc, 'div', { class: 'app-header-brand' });
    if (cfg.brand) brandZone.appendChild(logoEl(doc, cfg.brand, 'app-header-logo'));
    if (cfg.title) {
        const title = el(doc, 'span', { class: 'app-header-title' });
        title.textContent = cfg.title;
        brandZone.appendChild(title);
    }

    /* ----- Nav zone: links + optional partner mark ----- */
    const navZone = el(doc, 'div', { class: 'app-header-end' });
    if (cfg.nav.length) navZone.appendChild(buildNav(doc, cfg.nav));
    for (const logo of cfg.partner) {
        navZone.appendChild(logoEl(doc, logo, 'app-header-logo app-header-logo--partner'));
    }

    header.append(brandZone, navZone);

    // Narrow viewports get a takeover menu rather than a squeezed nav row.
    // The button is always in the DOM and hidden by a media query, so no
    // resize listener is needed to keep it in sync.
    if (cfg.nav.length) {
        const { button, panel } = buildMobileMenu(doc, cfg.nav);
        header.appendChild(button);
        doc.body.appendChild(panel);
    }

    doc.body.appendChild(header);

    return {
        element: header,
        // The chat footer shows the same links; with a nav they'd appear twice.
        absorbsLinks: cfg.nav.length > 0,
        height: HEADER_BASE_HEIGHT_PX,
    };
}

function buildNav(doc, items) {
    const nav = el(doc, 'nav', { id: 'app-header-nav', 'aria-label': 'Site' });
    for (const item of items) nav.appendChild(navLink(doc, item, 'app-header-link'));
    return nav;
}

function buildMobileMenu(doc, items) {
    const button = el(doc, 'button', {
        id: 'app-header-menu-btn',
        type: 'button',
        'aria-label': 'Open menu',
        'aria-expanded': 'false',
        'aria-controls': 'app-header-menu',
    });
    button.innerHTML = '<span></span><span></span><span></span>';

    const panel = el(doc, 'div', {
        id: 'app-header-menu',
        hidden: '',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': 'Site menu',
        tabindex: '-1',
    });
    const close = el(doc, 'button', {
        class: 'app-header-menu-close',
        type: 'button',
        'aria-label': 'Close menu',
    });
    close.textContent = '✕';

    const list = el(doc, 'nav', { 'aria-label': 'Site' });
    for (const item of items) list.appendChild(navLink(doc, item, 'app-header-menu-link'));
    panel.append(close, list);

    const setOpen = open => {
        panel.hidden = !open;
        button.setAttribute('aria-expanded', String(open));
        // Move focus with the panel, and hand it back to the control that
        // opened it — otherwise a keyboard user is left at the top of the
        // document with no idea the panel closed.
        if (open) close.focus();
        else button.focus();
    };
    button.addEventListener('click', () => setOpen(panel.hidden));
    close.addEventListener('click', () => setOpen(false));
    panel.addEventListener('keydown', e => {
        if (e.key === 'Escape') setOpen(false);
    });
    // Tapping a link navigates away, but close anyway so a same-page target
    // doesn't leave the takeover covering the map.
    list.addEventListener('click', e => {
        if (e.target.closest('a')) setOpen(false);
    });

    return { button, panel };
}

const ICONS = { github: githubIcon, leaf: leafIcon };

function navLink(doc, item, className) {
    const a = el(doc, 'a', { class: className, href: item.href });
    if (item.variant) a.classList.add(`${className}--${item.variant}`);
    if (item.external) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
    }
    // Icon first, then the label as a text node. The icon is aria-hidden, so
    // the accessible name is the label either way.
    if (ICONS[item.icon]) {
        const slot = el(doc, 'span', { class: 'app-header-link-icon' });
        slot.innerHTML = ICONS[item.icon]();
        a.appendChild(slot);
    }
    a.appendChild(doc.createTextNode(item.label));
    return a;
}

function logoEl(doc, logo, className) {
    let img;
    if (logo.srcDark) {
        // Both variants are rendered and CSS picks one, rather than JS
        // choosing at boot — that way `theme: auto` can follow the OS live.
        img = el(doc, 'span', { class: 'app-header-logo-pair' });
        img.append(
            el(doc, 'img', { class: `${className} app-header-logo--light`, src: logo.src, alt: logo.alt }),
            el(doc, 'img', { class: `${className} app-header-logo--dark`, src: logo.srcDark, alt: logo.alt }),
        );
    } else {
        img = el(doc, 'img', { class: className, src: logo.src, alt: logo.alt });
    }
    if (!logo.href) return img;

    const a = el(doc, 'a', {
        class: 'app-header-logo-link',
        href: logo.href,
        target: '_blank',
        rel: 'noopener noreferrer',
    });
    a.appendChild(img);
    return a;
}

function el(doc, tag, attrs = {}) {
    const node = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
}
