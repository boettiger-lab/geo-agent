// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { MapManager } from '../app/map-manager.js';

/**
 * Tooltip and legend render untrusted strings: vector-tile feature values,
 * LLM-chosen tooltip field names, and STAC metadata (display names, class
 * names, color hints). These tests pin that none of them can inject DOM.
 */

function createTooltipManager(tooltipFields) {
    const handlers = {};
    const map = {
        on: (event, layerId, cb) => { handlers[`${event}:${layerId}`] = cb; },
        getCanvas: () => ({ style: {} }),
    };
    const mm = Object.create(MapManager.prototype);
    mm.map = map;
    mm._tooltip = document.createElement('div');
    mm._tooltip.style.display = 'none';
    mm.layers = new Map([['A', { mapLayerId: 'layer-A', tooltipFields }]]);
    mm._wireTooltip('layer-A', 'A');
    const hover = (props) => handlers['mousemove:layer-A']({
        features: [{ properties: props }],
        originalEvent: { clientX: 10, clientY: 20 },
    });
    return { mm, hover };
}

describe('MapManager tooltip (SEC-2)', () => {
    it('renders HTML in feature values as inert text', () => {
        const { mm, hover } = createTooltipManager(['name']);
        hover({ name: '<img src=x onerror="window.__pwned=1">' });
        expect(mm._tooltip.querySelector('img')).toBeNull();
        expect(mm._tooltip.textContent).toContain('<img');
    });

    it('renders HTML in field names as inert text', () => {
        const field = '<b onmouseover=alert(1)>owner</b>';
        const { mm, hover } = createTooltipManager([field]);
        hover({ [field]: 'Jane' });
        expect(mm._tooltip.querySelector('b')).toBeNull();
        expect(mm._tooltip.textContent).toContain('Jane');
    });

    it('keeps currency and acreage number formatting', () => {
        const { mm, hover } = createTooltipManager(['assessed_value', 'acres']);
        hover({ assessed_value: 1234567, acres: 12345.67 });
        const cells = [...mm._tooltip.querySelectorAll('td')].map(td => td.textContent);
        expect(cells).toContain('$1,234,567');
        expect(cells).toContain('12,345.7');
    });

    it('still renders a table with one row per non-empty field', () => {
        const { mm, hover } = createTooltipManager(['a', 'b', 'c']);
        hover({ a: 'x', b: '', c: 'z' });
        expect(mm._tooltip.querySelectorAll('tr')).toHaveLength(2);
        expect(mm._tooltip.style.display).toBe('block');
    });

    it('bails out without showing the tooltip when all values are empty', () => {
        const { mm, hover } = createTooltipManager(['a']);
        hover({ a: '' });
        expect(mm._tooltip.style.display).toBe('none');
    });
});

function createLegendManager(state) {
    const mm = Object.create(MapManager.prototype);
    mm.layers = new Map([['A', state]]);
    mm._legendEl = document.createElement('div');
    mm._legendContent = document.createElement('div');
    mm._legendItems = new Map();
    mm._ensureLegend = () => {};
    return mm;
}

describe('MapManager raster legend (SEC-3)', () => {
    it('renders HTML in categorical class names as inert text', async () => {
        const mm = createLegendManager({
            displayName: 'Land cover',
            legendType: 'categorical',
            legendClasses: [{ name: '<img src=x onerror=alert(1)>', 'color-hint': 'ff0000' }],
        });
        await mm._showLegend('A');
        expect(mm._legendContent.querySelector('img')).toBeNull();
        expect(mm._legendContent.textContent).toContain('<img');
    });

    it('renders HTML in the display name as inert text (both branches)', async () => {
        const mm = createLegendManager({
            displayName: '<script>alert(1)</script>Cover',
            legendType: 'categorical',
            legendClasses: [{ name: 'Forest', 'color-hint': '00ff00' }],
        });
        await mm._showLegend('A');
        expect(mm._legendContent.querySelector('script')).toBeNull();
        expect(mm._legendContent.querySelector('h4').textContent).toContain('Cover');
    });

    it('applies a valid color-hint to the swatch', async () => {
        const mm = createLegendManager({
            displayName: 'Land cover',
            legendType: 'categorical',
            legendClasses: [{ name: 'Forest', 'color-hint': '00ff00' }],
        });
        await mm._showLegend('A');
        const swatch = mm._legendContent.querySelector('.legend-item span');
        expect(swatch.getAttribute('style')).toMatch(/00ff00|rgb\(0,\s*255,\s*0\)/i);
    });

    it('falls back to grey when color-hint is not a hex color (attribute breakout)', async () => {
        const mm = createLegendManager({
            displayName: 'Land cover',
            legendType: 'categorical',
            legendClasses: [{ name: 'Evil', 'color-hint': 'red;"></span><img src=x onerror=alert(1)>' }],
        });
        await mm._showLegend('A');
        expect(mm._legendContent.querySelector('img')).toBeNull();
        const swatch = mm._legendContent.querySelector('.legend-item span');
        expect(swatch.getAttribute('style')).toMatch(/888888|rgb\(136,\s*136,\s*136\)/i);
    });

    it('keeps the gradient branch: rescale labels with unit suffix, name as text', async () => {
        const mm = createLegendManager({
            displayName: '<i>Carbon</i>',
            colormap: 'reds',
            rescale: '0,100',
            legendLabel: 'tC/ha',
        });
        mm._getColormapGradient = async () => 'linear-gradient(to right, #fff, #000)';
        await mm._showLegend('A');
        expect(mm._legendContent.querySelector('i')).toBeNull();
        const labels = [...mm._legendContent.querySelectorAll('.legend-labels span')].map(s => s.textContent);
        expect(labels).toEqual(['0 tC/ha', '100 tC/ha']);
        const bar = mm._legendContent.querySelector('.legend-colorbar');
        expect(bar.getAttribute('style')).toContain('linear-gradient');
    });

    it('renders a categorical legend for a vector layer (issue #118)', async () => {
        const mm = createLegendManager({
            type: 'vector',
            displayName: 'Seafloor Geomorphology',
            legendType: 'categorical',
            legendClasses: [
                { name: 'Seamounts', 'color-hint': '#F57F17' },
                { name: 'Ridges', 'color-hint': '#BF360C' },
            ],
        });
        await mm._showLegend('A');
        const rows = mm._legendContent.querySelectorAll('.legend-item');
        expect(rows).toHaveLength(2);
        expect(mm._legendContent.textContent).toContain('Seamounts');
        expect(mm._legendContent.textContent).toContain('Ridges');
    });
});

describe('MapManager._hasLegend', () => {
    const mm = Object.create(MapManager.prototype);

    it('is true for any raster layer (continuous colorbar)', () => {
        expect(mm._hasLegend({ type: 'raster' })).toBe(true);
    });

    it('is true for a categorical vector layer with classes', () => {
        expect(mm._hasLegend({
            type: 'vector', legendType: 'categorical',
            legendClasses: [{ name: 'A', 'color-hint': 'ff0000' }],
        })).toBe(true);
    });

    it('is false for a plain vector layer', () => {
        expect(mm._hasLegend({ type: 'vector' })).toBeFalsy();
    });

    it('is false for a vector layer flagged categorical but with no classes', () => {
        expect(mm._hasLegend({ type: 'vector', legendType: 'categorical', legendClasses: [] })).toBeFalsy();
    });
});
