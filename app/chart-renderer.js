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

    let mark;
    switch (type) {
        case 'bar':       mark = Plot.barY(rows, { x, y, fill: series, tip: true }); break;
        case 'line':      mark = Plot.lineY(rows, { x, y, stroke: series, marker: 'circle', tip: true }); break;
        case 'scatter':   mark = Plot.dot(rows, { x, y, stroke: series, tip: true }); break;
        case 'histogram': mark = Plot.rectY(rows, Plot.binX({ y: 'count' }, { x, tip: true })); break;
    }

    const marks = [];
    // A baseline at y=0 reads more honestly for bars/lines/histograms.
    if (type !== 'scatter') marks.push(Plot.ruleY([0]));
    marks.push(mark);

    return {
        marginLeft: 60,
        marginBottom: 44,
        marginTop: 16,
        grid: true,
        x: { label: spec.x_label ?? x ?? null },
        y: { label: spec.y_label ?? (type === 'histogram' ? 'count' : y) ?? null },
        // histogram bins ignore `series`, so a color legend there would be empty.
        ...(series && type !== 'histogram' && { color: { legend: true } }),
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
        const Plot = await this._loadPlot();
        const options = buildPlotOptions(Plot, spec, rows);
        const figure = Plot.plot(options);

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
        const close = this.doc.createElement('button');
        close.className = 'chart-panel-close';
        close.title = 'Close chart';
        close.textContent = '✕';
        close.addEventListener('click', () => this.remove(id));
        header.appendChild(title);
        header.appendChild(close);

        const body = this.doc.createElement('div');
        body.className = 'chart-panel-body';
        body.appendChild(figure);

        panel.appendChild(header);
        panel.appendChild(body);

        // Cascade panels up the bottom-right corner of the MAP area. Use the
        // monotonic sequence (not the live panel count) so closing a middle
        // panel can't make the next chart land exactly on an open one; wrap
        // after a few so it stays on-screen. The base anchor is set in CSS via
        // calc(--sidebar-width + --chart-cascade) so panels clear the sidebar
        // in sidebar-mode layouts instead of hiding behind it.
        const offset = 12 + ((this._seq - 1) % 6) * 20;
        panel.style.setProperty('--chart-cascade', offset + 'px');

        this.doc.body.appendChild(panel);
        this._panels.set(id, panel);
        return { id };
    }

    remove(id) {
        const panel = this._panels.get(id);
        if (panel) { panel.remove(); this._panels.delete(id); }
    }

    removeAll() {
        for (const id of [...this._panels.keys()]) this.remove(id);
    }
}

function cap(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
