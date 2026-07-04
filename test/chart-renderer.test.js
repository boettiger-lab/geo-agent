import { describe, it, expect, afterEach } from 'vitest';
import { buildPlotOptions, ChartRenderer } from '../app/chart-renderer.js';

// Fake Plot namespace: each mark factory returns a tagged object so we can
// assert mark selection + channel mapping without the real library.
const fakePlot = {
    barY: (data, opts) => ({ mark: 'barY', data, opts }),
    lineY: (data, opts) => ({ mark: 'lineY', data, opts }),
    dot: (data, opts) => ({ mark: 'dot', data, opts }),
    rectY: (data, opts) => ({ mark: 'rectY', data, opts }),
    binX: (outputs, opts) => ({ binX: outputs, opts }),
    ruleY: (data) => ({ mark: 'ruleY', data }),
    plot: (options) => ({ plotted: options }),
};

const rows = [{ country: 'Brazil', pct: 31 }, { country: 'Peru', pct: 22 }];

describe('buildPlotOptions', () => {
    it('bar → barY with x/y/fill channels and a y=0 baseline', () => {
        const o = buildPlotOptions(fakePlot, { chart_type: 'bar', x: 'country', y: 'pct', series: 'region' }, rows);
        const bar = o.marks.find(m => m.mark === 'barY');
        expect(bar.data).toBe(rows);
        expect(bar.opts).toMatchObject({ x: 'country', y: 'pct', fill: 'region' });
        expect(o.marks.some(m => m.mark === 'ruleY')).toBe(true);
        // series → legend, painted from the fixed categorical range
        expect(o.color).toMatchObject({ legend: true });
        expect(Array.isArray(o.color.range)).toBe(true);
    });

    it('scatter → filled dots, no y=0 baseline, no legend without series', () => {
        const o = buildPlotOptions(fakePlot, { chart_type: 'scatter', x: 'carbon', y: 'biodiversity' }, rows);
        expect(o.marks.some(m => m.mark === 'ruleY')).toBe(false);
        const dot = o.marks.find(m => m.mark === 'dot');
        expect(dot.opts.fill).toBe('#2a78d6');   // bold filled color, not an open circle
        expect(dot.opts.r).toBeGreaterThanOrEqual(4);
        expect(o.color).toBeUndefined();   // no series → no legend
    });

    it('line → lineY', () => {
        const o = buildPlotOptions(fakePlot, { chart_type: 'line', x: 'year', y: 'effort' }, rows);
        expect(o.marks.some(m => m.mark === 'lineY')).toBe(true);
    });

    it('histogram → rectY+binX, count on y, no y column required', () => {
        const o = buildPlotOptions(fakePlot, { chart_type: 'histogram', x: 'richness' }, rows);
        const rect = o.marks.find(m => m.mark === 'rectY');
        expect(rect.opts.binX).toEqual({ y: 'count' });
        expect(o.y.label).toBe('count');
    });

    it('uses explicit axis labels when provided, else the column name', () => {
        const o = buildPlotOptions(fakePlot, { chart_type: 'bar', x: 'country', y: 'pct', x_label: 'Country', y_label: '% protected' }, rows);
        expect(o.x.label).toBe('Country');
        expect(o.y.label).toBe('% protected');
    });

    it('throws on an unsupported chart type', () => {
        expect(() => buildPlotOptions(fakePlot, { chart_type: 'pie', x: 'a', y: 'b' }, rows)).toThrow(/Unsupported chart_type/);
    });

    it('throws when x is missing, or y is missing for a non-histogram', () => {
        expect(() => buildPlotOptions(fakePlot, { chart_type: 'bar', y: 'v' }, rows)).toThrow(/requires an x/);
        expect(() => buildPlotOptions(fakePlot, { chart_type: 'bar', x: 'c' }, rows)).toThrow(/requires a y/);
    });
});

describe('ChartRenderer', () => {
    afterEach(() => { delete globalThis.Plot; });

    it('prefers a preloaded global Plot and returns an id (headless: doc=null)', async () => {
        globalThis.Plot = fakePlot;
        const cr = new ChartRenderer({ doc: null });
        const { id } = await cr.render({ chart_type: 'bar', x: 'country', y: 'pct' }, rows);
        expect(id).toMatch(/^chart-\d+$/);
    });

    it('propagates validation errors before touching the DOM', async () => {
        globalThis.Plot = fakePlot;
        const cr = new ChartRenderer({ doc: null });
        await expect(cr.render({ chart_type: 'pie', x: 'a', y: 'b' }, rows)).rejects.toThrow(/Unsupported/);
    });

    it('_drawFigure re-plots sized to the panel body (resize reflow)', () => {
        const cr = new ChartRenderer({ doc: null });
        let captured;
        cr._plot = { ...fakePlot, plot: (o) => { captured = o; return { tag: 'fig' }; } };
        const replaced = [];
        const entry = {
            body: { clientWidth: 500, clientHeight: 400, replaceChildren: (f) => replaced.push(f) },
            spec: { chart_type: 'bar', x: 'country', y: 'pct' },
            rows,
        };
        cr._drawFigure(entry);
        expect(captured.width).toBe(500);
        expect(captured.height).toBe(400);
        expect(replaced).toEqual([{ tag: 'fig' }]);
    });

    it('_drawFigure falls back to default size when the body has no layout yet', () => {
        const cr = new ChartRenderer({ doc: null });
        let captured;
        cr._plot = { ...fakePlot, plot: (o) => { captured = o; return {}; } };
        const entry = {
            body: { clientWidth: 0, clientHeight: 0, replaceChildren: () => {} },
            spec: { chart_type: 'scatter', x: 'a', y: 'b' },
            rows,
        };
        cr._drawFigure(entry);
        expect(captured.width).toBe(400);
        expect(captured.height).toBe(300);
    });
});
