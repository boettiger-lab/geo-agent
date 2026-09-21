// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { ensureRail, mountOverlay, RAIL_ID, SLOT } from '../app/overlay-rail.js';

/** A panel-ish element, like the ones the real callers build. */
function panel(cls) {
    const el = document.createElement('div');
    if (cls) el.className = cls;
    return el;
}

beforeEach(() => {
    document.body.innerHTML = '';
});

describe('ensureRail', () => {
    it('creates the rail on first call and appends it to the body', () => {
        expect(document.getElementById(RAIL_ID)).toBeNull();
        const rail = ensureRail(document);
        expect(rail.id).toBe(RAIL_ID);
        expect(rail.parentNode).toBe(document.body);
    });

    it('is idempotent — a second call returns the same element', () => {
        const first = ensureRail(document);
        const second = ensureRail(document);
        expect(second).toBe(first);
        expect(document.querySelectorAll(`#${RAIL_ID}`)).toHaveLength(1);
    });

    it('defaults to the global document', () => {
        expect(ensureRail()).toBe(document.getElementById(RAIL_ID));
    });
});

describe('mountOverlay', () => {
    it('creates the rail lazily — no panels means no rail element', () => {
        // A deployment with no legend, sliders or hex grid should not get a
        // stray empty div over the map.
        expect(document.getElementById(RAIL_ID)).toBeNull();
    });

    it('moves the panel into the rail and sets its slot order', () => {
        const p = panel('reactive-controls');
        mountOverlay(p, SLOT.REACTIVE);
        expect(p.parentNode.id).toBe(RAIL_ID);
        expect(p.style.order).toBe(String(SLOT.REACTIVE));
    });

    it('orders panels by slot regardless of mount order', () => {
        // Mount bottom-of-column first, top-of-column last: the DOM order is
        // irrelevant because the rail is a flex column driven by `order`.
        const toggle = panel('h3-toggle');
        const anim = panel('anim-controls');
        const legend = panel('legend');

        mountOverlay(toggle, SLOT.HEX_TOGGLE);
        mountOverlay(anim, SLOT.ANIMATION);
        mountOverlay(legend, SLOT.LEGEND);

        const orders = [...document.getElementById(RAIL_ID).children]
            .map(el => Number(el.style.order));
        expect(orders).toEqual([SLOT.HEX_TOGGLE, SLOT.ANIMATION, SLOT.LEGEND]);
        // The legend sorts above the animation panel, which sorts above the
        // hex toggle — the toggle stays nearest the map corner.
        expect(SLOT.LEGEND).toBeLessThan(SLOT.ANIMATION);
        expect(SLOT.ANIMATION).toBeLessThan(SLOT.HEX_TOGGLE);
    });

    it('stacks same-slot panels without overlapping them', () => {
        // Two reactive sliders used to collide once the hand-computed
        // `bottom` offset was assigned; now they are siblings in a flex
        // column and neither carries an inline offset at all (#359).
        const a = panel('reactive-controls');
        const b = panel('reactive-controls');
        mountOverlay(a, SLOT.REACTIVE);
        mountOverlay(b, SLOT.REACTIVE);

        expect(document.getElementById(RAIL_ID).children).toHaveLength(2);
        expect(a.style.bottom).toBe('');
        expect(b.style.bottom).toBe('');
    });

    it('re-mounting an existing panel updates its slot without duplicating it', () => {
        const p = panel();
        mountOverlay(p, SLOT.ANIMATION);
        mountOverlay(p, SLOT.LEGEND);
        expect(document.getElementById(RAIL_ID).children).toHaveLength(1);
        expect(p.style.order).toBe(String(SLOT.LEGEND));
    });

    it('removing a panel leaves no gap for the survivors', () => {
        // The old arithmetic computed each offset once at mount, so a
        // destroyed panel left a hole and the next mount landed on a
        // survivor. Removal is now just a DOM removal.
        const a = panel();
        const b = panel();
        mountOverlay(a, SLOT.ANIMATION);
        mountOverlay(b, SLOT.REACTIVE);
        a.remove();

        const rail = document.getElementById(RAIL_ID);
        expect([...rail.children]).toEqual([b]);
    });

    it('honours an explicit document argument', () => {
        // ReactiveControl passes its own `doc` so it can be driven in tests.
        const doc = document.implementation.createHTMLDocument('rail');
        const p = doc.createElement('div');
        mountOverlay(p, SLOT.REACTIVE, doc);

        expect(doc.getElementById(RAIL_ID).contains(p)).toBe(true);
        expect(document.getElementById(RAIL_ID)).toBeNull();
    });

    it('infers the document from the element when none is passed', () => {
        const doc = document.implementation.createHTMLDocument('rail');
        const p = doc.createElement('div');
        mountOverlay(p, SLOT.LEGEND);

        expect(doc.getElementById(RAIL_ID).contains(p)).toBe(true);
        expect(document.getElementById(RAIL_ID)).toBeNull();
    });
});

describe('SLOT', () => {
    it('has no duplicate values', () => {
        const values = Object.values(SLOT);
        expect(new Set(values).size).toBe(values.length);
    });

    it('leaves room between tiers for a new panel type', () => {
        const sorted = Object.values(SLOT).sort((a, b) => a - b);
        for (let i = 1; i < sorted.length; i++) {
            expect(sorted[i] - sorted[i - 1]).toBeGreaterThan(1);
        }
    });
});
