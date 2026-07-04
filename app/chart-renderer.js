/**
 * chart-renderer.js — Opt-in lightweight charting primitive (#277)
 *
 * Turns a query result set into a static chart (bar / line / scatter /
 * histogram) rendered in a floating panel over the map. Generic, not
 * app-specific: the agent runs a `query`, then hands the rows (or the SQL) to
 * the `render_chart` tool, which calls ChartRenderer.render here.
 *
 * The charting library (Observable Plot) is loaded lazily from the CDN the
 * first time a chart is drawn — so apps that don't enable charts pay nothing,
 * and downstream apps don't need to add a <script> tag to their index.html.
 *
 * `buildPlotOptions` is pure (Plot is injected) so the mark-selection /
 * channel-mapping logic is unit-tested without a DOM or a network fetch.
 */

// Observable Plot ships as ESM + a UMD bundle whose browser global expects a
// `d3` global, so we load d3 then Plot via SRI-pinned <script> tags — matching
// the opt-in CDN convention in map-draw.js / map-geocoder.js. Lazy: nothing
// loads until the first chart is drawn.
const D3_JS = 'https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js';
const D3_JS_SRI = 'sha384-CjloA8y00+1SDAUkjs099PVfnY2KmDC2BZnws9kh8D/lX1s46w6EPhpXdqMfjK6i';
const PLOT_JS = 'https://cdn.jsdelivr.net/npm/@observablehq/plot@0.6.16/dist/plot.umd.min.js';
const PLOT_JS_SRI = 'sha384-XzQ+KW4LBWHv6FLjiPA1vjDz//oGlY8We4XROgpir5jHgg2+Qvo/6fT5TjbnqyYi';

const CHART_TYPES = ['bar', 'line', 'scatter', 'histogram'];

// Bold, readable defaults. Categorical range is the validated CVD-safe palette
// (dataviz skill, light surface) — assigned in fixed order, never cycled. A
// chart with no `series` uses one confident color instead of Plot's thin
// default. Text stays ink; only marks carry the data color.
const CATEGORICAL = ['#2a78d6', '#1baf7a', '#eda100', '#008300', '#4a3aa7', '#e34948', '#e87ba4', '#eb6834'];
const SERIES_1 = '#2a78d6';   // default single-series color (bold blue)
const INK = '#1a1a1a';        // axis / label text
const CHART_FONT = "'Open Sans', system-ui, -apple-system, sans-serif";

/** Load a JS script by URL with SRI; resolves when loaded. */
function loadScript(url, integrity) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = url;
        if (integrity) {
            s.integrity = integrity;
            s.crossOrigin = 'anonymous';
        }
        s.onload = resolve;
        s.onerror = () => reject(new Error(`Failed to load ${url}`));
        document.head.appendChild(s);
    });
}

/** True when `p` looks like the Observable Plot namespace we need. */
function isPlot(p) {
    return !!p && typeof p.plot === 'function' && typeof p.barY === 'function' && typeof p.binX === 'function';
}

/**
 * Validate a chart spec (pure, no Plot/DOM). Lets the tool reject a bad spec
 * before paying for an MCP/SQL round-trip.
 * @throws if chart_type is unsupported or a required channel is missing
 */
export function validateChartSpec(spec) {
    const type = spec.chart_type;
    if (!CHART_TYPES.includes(type)) {
        throw new Error(`Unsupported chart_type "${type}". Use one of: ${CHART_TYPES.join(', ')}.`);
    }
    if (!spec.x) throw new Error(`chart_type "${type}" requires an x column.`);
    if (type !== 'histogram' && !spec.y) throw new Error(`chart_type "${type}" requires a y column.`);
}

/**
 * Build the Observable Plot options object for a chart spec + rows.
 * Pure: the Plot namespace is passed in, so callers (and tests) control it.
 *
 * @param {Object} Plot — the Observable Plot namespace (barY, lineY, dot, …)
 * @param {Object} spec — { chart_type, x, y, series, x_label, y_label }
 * @param {Array<Object>} rows — result rows
 * @returns {Object} options for Plot.plot()
 * @throws if chart_type is unsupported or required channels are missing
 */
export function buildPlotOptions(Plot, spec, rows) {
    validateChartSpec(spec);
    const type = spec.chart_type;
    const { x, y, series } = spec;

    // A single confident color when there's no `series`; a real grouping paints
    // marks from the categorical range. A string that is a valid CSS color is a
    // constant fill/stroke in Plot; a column name is a channel — so `series`
    // colors by category and `SERIES_1` is a flat bold color.
    const paint = series || SERIES_1;

    let mark;
    switch (type) {
        case 'bar':
            // Filled bars, a 2px surface gap between neighbors (never a stroke).
            mark = Plot.barY(rows, { x, y, fill: paint, insetLeft: 1, insetRight: 1, tip: true });
            break;
        case 'line':
            // A bold 2.5px line reads over the basemap; no per-point markers —
            // those are chart-junk. The tooltip and endpoints carry the points.
            mark = Plot.lineY(rows, { x, y, stroke: paint, strokeWidth: 2.5, strokeLinejoin: 'round', strokeLinecap: 'round', tip: true });
            break;
        case 'scatter':
            // Big FILLED dots with a white surface ring — not small open circles.
            mark = Plot.dot(rows, { x, y, fill: paint, r: 5, stroke: 'white', strokeWidth: 1.5, tip: true });
            break;
        case 'histogram':
            mark = Plot.rectY(rows, Plot.binX({ y: 'count' }, { x, fill: SERIES_1, insetLeft: 1, insetRight: 1, tip: true }));
            break;
    }

    const marks = [];
    // A baseline at y=0 reads more honestly for bars/lines/histograms.
    if (type !== 'scatter') marks.push(Plot.ruleY([0]));
    marks.push(mark);

    // --- de-crowd the x axis ---------------------------------------------
    // Categorical axes overcrowd and overprint the fastest. When there are many
    // bands or long labels, rotate the ticks and reserve room instead of letting
    // Plot stack them on top of each other; cap continuous ticks so numbers
    // don't collide.
    const xVals = rows.map(r => r && r[x]);
    const numericX = xVals.every(v => v == null || typeof v === 'number');
    const distinctX = new Set(xVals).size;
    const longestX = xVals.reduce((m, v) => Math.max(m, String(v ?? '').length), 0);
    const rotateX = !numericX && (distinctX > 6 || longestX > 8);

    const xAxis = { label: spec.x_label ?? x ?? null };
    let marginBottom = 48;
    if (rotateX) {
        xAxis.tickRotate = -35;
        marginBottom = Math.min(120, 48 + Math.round(longestX * 4.5));
    } else if (numericX) {
        xAxis.ticks = 6;
    }

    // Short SI tick labels (1k, 2.5M) keep the y axis readable and let the left
    // margin stay tight. Only when y is actually quantitative.
    const yVals = type === 'histogram' ? [] : rows.map(r => r && r[y]);
    const numericY = type === 'histogram' || yVals.every(v => v == null || typeof v === 'number');
    const yAxis = { label: spec.y_label ?? (type === 'histogram' ? 'count' : y) ?? null, grid: true };
    if (numericY) yAxis.tickFormat = '~s';

    return {
        marginLeft: 56,
        marginBottom,
        marginTop: 18,
        marginRight: 18,
        // Bigger, bolder type; the whole figure inherits it (axes + legend).
        style: { fontSize: '13px', fontFamily: CHART_FONT, color: INK, background: 'transparent' },
        x: xAxis,
        y: yAxis,
        // histogram bins ignore `series`, so a color legend there would be empty.
        ...(series && type !== 'histogram' && { color: { legend: true, range: CATEGORICAL } }),
        marks,
    };
}

export class ChartRenderer {
    /**
     * @param {Object} [opts]
     * @param {Document} [opts.doc] — injectable for tests
     */
    constructor(opts = {}) {
        this.doc = opts.doc || (typeof document !== 'undefined' ? document : null);
        this._plot = null;
        this._seq = 0;
        this._z = 3;                // top stacking order (matches .chart-panel z-index)
        this._panels = new Map();   // id → panel element
    }

    /**
     * Lazy-load Observable Plot once (d3 first, then Plot). Reuses a valid
     * preloaded global if present; otherwise injects the SRI-pinned scripts.
     */
    async _loadPlot() {
        if (this._plot) return this._plot;
        if (isPlot(globalThis.Plot)) {
            this._plot = globalThis.Plot;
            return this._plot;
        }
        if (typeof document === 'undefined') {
            throw new Error('Charting requires a browser document to load Observable Plot.');
        }
        if (typeof globalThis.d3 === 'undefined') await loadScript(D3_JS, D3_JS_SRI);
        await loadScript(PLOT_JS, PLOT_JS_SRI);
        if (!isPlot(globalThis.Plot)) {
            throw new Error('Observable Plot loaded but its API was not found on window.Plot.');
        }
        this._plot = globalThis.Plot;
        return this._plot;
    }

    /**
     * Render a chart into a floating panel. Returns { id } once mounted.
     * @param {Object} spec — see buildPlotOptions
     * @param {Array<Object>} rows
     */
    async render(spec, rows) {
        validateChartSpec(spec);      // reject a bad spec before touching the DOM
        await this._loadPlot();

        const id = `chart-${++this._seq}`;
        if (!this.doc) return { id };   // headless (shouldn't happen in-app)

        const panel = this.doc.createElement('div');
        panel.className = 'chart-panel';
        panel.dataset.chartId = id;

        const header = this.doc.createElement('div');
        header.className = 'chart-panel-header';
        const title = this.doc.createElement('span');
        title.className = 'chart-panel-title';
        title.textContent = spec.title || `${cap(spec.chart_type)} chart`;

        // Pop-out: toggle between the docked corner card and a large centered
        // view. The size change is picked up by the ResizeObserver, which
        // re-plots to fit — so charts stay sharp at any size.
        const pop = this.doc.createElement('button');
        pop.className = 'chart-panel-pop';
        pop.title = 'Pop out / restore';
        pop.textContent = '⤢';
        pop.addEventListener('click', () => {
            const popped = panel.classList.toggle('chart-panel--popped');
            pop.textContent = popped ? '⤡' : '⤢';
        });

        const close = this.doc.createElement('button');
        close.className = 'chart-panel-close';
        close.title = 'Close chart';
        close.textContent = '✕';
        close.addEventListener('click', () => this.remove(id));

        header.appendChild(title);
        header.appendChild(pop);
        header.appendChild(close);

        const body = this.doc.createElement('div');
        body.className = 'chart-panel-body';

        // Custom resize grip in the TOP-LEFT corner. The panel is anchored to
        // its bottom-right, so the free corner to drag is the top-left; native
        // CSS `resize` can only grip the bottom-right (which sits jammed in the
        // screen corner here), so we drive width/height from a pointer drag and
        // let the ResizeObserver re-plot. Min/max come from the CSS box.
        const grip = this.doc.createElement('div');
        grip.className = 'chart-panel-resize';
        grip.title = 'Drag to resize';

        panel.appendChild(grip);
        panel.appendChild(header);
        panel.appendChild(body);
        this._wireResize(panel, grip);

        // Clicking anywhere in a panel raises it above the others, so a chart
        // buried under the cascade can be brought forward without closing the
        // ones on top of it. New panels also open on top.
        panel.addEventListener('pointerdown', () => this._bringToFront(panel));
        this._bringToFront(panel);

        // Cascade panels up the bottom-right corner of the MAP area. Use the
        // monotonic sequence (not the live panel count) so closing a middle
        // panel can't make the next chart land exactly on an open one; wrap
        // after a few so it stays on-screen. The base anchor is set in CSS via
        // calc(--sidebar-width + --chart-cascade) so panels clear the sidebar
        // in sidebar-mode layouts instead of hiding behind it.
        const offset = 12 + ((this._seq - 1) % 6) * 20;
        panel.style.setProperty('--chart-cascade', offset + 'px');

        this.doc.body.appendChild(panel);

        const entry = { panel, body, spec, rows, observer: null, raf: 0 };
        this._drawFigure(entry);

        // Re-plot to fit whenever the user drags the resize grip or pops out.
        if (typeof ResizeObserver !== 'undefined') {
            entry.observer = new ResizeObserver(() => {
                if (entry.raf) cancelAnimationFrame(entry.raf);
                entry.raf = requestAnimationFrame(() => this._drawFigure(entry));
            });
            entry.observer.observe(body);
        }

        this._panels.set(id, entry);
        return { id };
    }

    /** Raise a panel above every other chart panel. */
    _bringToFront(panel) {
        if (!panel) return;
        panel.style.zIndex = String(++this._z);
    }

    /**
     * Drive a top-left resize grip. Dragging up/left grows the panel; the box
     * stays pinned at its bottom-right anchor. Clamping is left to the CSS
     * min/max-width/height. Pointer capture keeps the drag alive off-grip.
     */
    _wireResize(panel, grip) {
        if (!grip || !grip.addEventListener) return;
        grip.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            const rect = panel.getBoundingClientRect();
            const startX = e.clientX, startY = e.clientY;
            const startW = rect.width, startH = rect.height;
            const move = (ev) => {
                panel.style.width = (startW + (startX - ev.clientX)) + 'px';
                panel.style.height = (startH + (startY - ev.clientY)) + 'px';
            };
            const up = () => {
                this.doc.removeEventListener('pointermove', move);
                this.doc.removeEventListener('pointerup', up);
            };
            this.doc.addEventListener('pointermove', move);
            this.doc.addEventListener('pointerup', up);
        });
    }

    /** (Re)render an entry's Plot figure sized to its current panel body. */
    _drawFigure(entry) {
        if (!entry || !this._plot || !entry.body) return;
        const { body, spec, rows } = entry;
        const width = Math.max(220, body.clientWidth || 400);
        const height = Math.max(160, body.clientHeight || 300);
        let figure;
        try {
            figure = this._plot.plot({ ...buildPlotOptions(this._plot, spec, rows), width, height });
        } catch {
            return;   // keep the prior figure on a transient draw error
        }
        body.replaceChildren(figure);
    }

    remove(id) {
        const entry = this._panels.get(id);
        if (!entry) return;
        if (entry.observer) entry.observer.disconnect();
        if (entry.raf) cancelAnimationFrame(entry.raf);
        entry.panel.remove();
        this._panels.delete(id);
    }

    removeAll() {
        for (const id of [...this._panels.keys()]) this.remove(id);
    }
}

function cap(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
