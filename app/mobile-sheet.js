/**
 * mobile-sheet.js — the sidebar becomes a bottom sheet on a phone.
 *
 * A side-by-side sidebar and map cannot both work at 390px wide, and the
 * previous narrow-viewport fallback just overlaid the desktop sidebar at 90vw
 * — neither a usable panel nor a usable map.
 *
 * Instead the panel moves to the bottom and gets three detents:
 *
 *   peek  — handle and tabs only; effectively a full-screen map
 *   half  — map above, panel below
 *   full  — effectively a full-screen panel
 *
 * `half` is the reason this is a sheet rather than a set of full-screen tabs.
 * Toggling a layer or asking a question is *about* the map; if the panel
 * covers it you act blind and check afterwards.
 *
 * ## Gestures
 *
 * Nothing is bound to the map surface. Horizontal drag there is pan, pinch is
 * zoom, and MapLibre keeps all of it — a swipe-to-switch gesture over the map
 * would misfire constantly. The sheet moves only from its own handle, and the
 * Layers/Chat switch is a tap. The handle is a real <button>, so the same
 * moves work from a keyboard.
 */

/** Matches the narrow-viewport rules in sidebar.css. */
export const SHEET_QUERY = '(max-width: 700px)';

/** Detent order, lowest first. `peek` is tall enough for handle + tabs. */
export const PEEK_PX = 96;

/**
 * The three detent heights in pixels, given the space available.
 *
 * Pure, and exported for tests.
 *
 * @param {number} viewportH
 * @param {number} headerH — the app header, which the sheet never covers
 * @returns {{peek: number, half: number, full: number}}
 */
export function detentHeights(viewportH, headerH = 0) {
    const full = Math.max(PEEK_PX, viewportH - headerH);
    return {
        peek: Math.min(PEEK_PX, full),
        half: Math.min(Math.max(PEEK_PX, Math.round(viewportH * 0.5)), full),
        full,
    };
}

/**
 * Snap a dragged height to whichever detent is closest.
 *
 * @param {number} height
 * @param {{peek:number, half:number, full:number}} detents
 * @returns {'peek'|'half'|'full'}
 */
export function nearestDetent(height, detents) {
    let best = 'peek';
    let bestGap = Infinity;
    for (const name of ['peek', 'half', 'full']) {
        const gap = Math.abs(detents[name] - height);
        if (gap < bestGap) {
            bestGap = gap;
            best = name;
        }
    }
    return best;
}

/** Next detent in a given direction, clamped at the ends. */
export function stepDetent(current, direction) {
    const order = ['peek', 'half', 'full'];
    const i = order.indexOf(current);
    if (i < 0) return 'peek';
    return order[Math.min(order.length - 1, Math.max(0, i + direction))];
}

/**
 * Turn the sidebar into a bottom sheet while the viewport is narrow.
 *
 * Safe to call once at boot: it watches the media query and only takes over
 * below the breakpoint, restoring the desktop layout above it.
 *
 * @param {HTMLElement} sidebar
 * @param {Object} [opts]
 * @param {Window} [opts.win]
 * @returns {{ destroy: () => void, setDetent: (d: string) => void }}
 */
export function initMobileSheet(sidebar, { win = window } = {}) {
    const doc = sidebar.ownerDocument;
    const body = doc.body;
    const mq = win.matchMedia(SHEET_QUERY);

    const { grabber, tabs, tabButtons } = buildControls(doc);
    let detent = 'peek';
    let active = 'layers';

    function currentDetents() {
        const headerH = parseFloat(
            win.getComputedStyle(doc.documentElement).getPropertyValue('--app-header-h'),
        ) || 0;
        return detentHeights(win.innerHeight, headerH);
    }

    function applyHeight(px, animate = true) {
        sidebar.classList.toggle('sheet-animating', animate);
        doc.documentElement.style.setProperty('--sheet-h', `${Math.round(px)}px`);
    }

    function setDetent(next) {
        detent = next;
        applyHeight(currentDetents()[next]);
        grabber.setAttribute('aria-label', `Panel ${next} — activate to expand`);
        body.dataset.sheetDetent = next;
    }

    function setTab(name) {
        active = name;
        body.dataset.sheetTab = name;
        for (const btn of tabButtons) {
            btn.setAttribute('aria-selected', String(btn.dataset.tab === name));
        }
        // Choosing a tab from the collapsed state should show what was asked
        // for, not just relabel a closed panel.
        if (detent === 'peek') setDetent('half');
    }

    /* ----- Drag: handle only, never the map ----- */
    let dragFrom = null;
    grabber.addEventListener('pointerdown', e => {
        dragFrom = { y: e.clientY, h: sidebar.getBoundingClientRect().height, moved: false };
        grabber.setPointerCapture(e.pointerId);
        sidebar.classList.remove('sheet-animating');
    });
    grabber.addEventListener('pointermove', e => {
        if (!dragFrom) return;
        const dy = dragFrom.y - e.clientY;
        if (Math.abs(dy) > 4) dragFrom.moved = true;
        const d = currentDetents();
        applyHeight(Math.min(d.full, Math.max(d.peek, dragFrom.h + dy)), false);
    });
    const endDrag = e => {
        if (!dragFrom) return;
        const moved = dragFrom.moved;
        dragFrom = null;
        if (e.pointerId != null && grabber.hasPointerCapture?.(e.pointerId)) {
            grabber.releasePointerCapture(e.pointerId);
        }
        if (!moved) {
            // A tap cycles rather than doing nothing — the handle is small,
            // and cycling is the obvious meaning of tapping a grabber.
            setDetent(detent === 'full' ? 'peek' : stepDetent(detent, 1));
            return;
        }
        setDetent(nearestDetent(sidebar.getBoundingClientRect().height, currentDetents()));
    };
    grabber.addEventListener('pointerup', endDrag);
    grabber.addEventListener('pointercancel', endDrag);

    grabber.addEventListener('keydown', e => {
        if (e.key === 'ArrowUp') { e.preventDefault(); setDetent(stepDetent(detent, 1)); }
        if (e.key === 'ArrowDown') { e.preventDefault(); setDetent(stepDetent(detent, -1)); }
    });

    for (const btn of tabButtons) {
        btn.addEventListener('click', () => setTab(btn.dataset.tab));
    }

    /* ----- Enable only while narrow ----- */
    function enable() {
        body.classList.add('sheet-mode');
        if (!grabber.isConnected) sidebar.prepend(grabber, tabs);
        setTab(active);
        setDetent(detent);
    }
    function disable() {
        body.classList.remove('sheet-mode');
        delete body.dataset.sheetDetent;
        delete body.dataset.sheetTab;
        doc.documentElement.style.removeProperty('--sheet-h');
        grabber.remove();
        tabs.remove();
    }
    const onChange = () => (mq.matches ? enable() : disable());

    onChange();
    mq.addEventListener?.('change', onChange);
    win.addEventListener('resize', () => { if (mq.matches) setDetent(detent); });

    return {
        setDetent,
        destroy() {
            mq.removeEventListener?.('change', onChange);
            disable();
        },
    };
}

function buildControls(doc) {
    const grabber = doc.createElement('button');
    grabber.id = 'sheet-grabber';
    grabber.type = 'button';
    grabber.setAttribute('aria-label', 'Panel peek — activate to expand');
    grabber.innerHTML = '<span></span>';

    const tabs = doc.createElement('div');
    tabs.id = 'sheet-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Panel');

    const tabButtons = [];
    for (const [name, label] of [['layers', 'Layers'], ['chat', 'Chat']]) {
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'sheet-tab';
        btn.dataset.tab = name;
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-selected', String(name === 'layers'));
        btn.textContent = label;
        tabs.appendChild(btn);
        tabButtons.push(btn);
    }
    return { grabber, tabs, tabButtons };
}
