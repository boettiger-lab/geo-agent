// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { MapManager } from '../app/map-manager.js';

/**
 * Legend grouping (#328): visible legend sections cluster under a `.legend-group`
 * heading matching their layer `group`, mirroring the layer panel. Ungrouped
 * layers stay flat (backward compatible), and a group heading disappears once all
 * its members are hidden.
 */

function createLegendManager(states) {
    const mm = Object.create(MapManager.prototype);
    mm.layers = new Map(Object.entries(states));
    mm._legendEl = document.createElement('div');
    mm._legendContent = document.createElement('div');
    mm._legendItems = new Map();
    mm._legendGroups = new Map();
    mm._ensureLegend = () => {};
    return mm;
}

const categorical = (displayName, group) => ({
    displayName,
    group,
    visible: true,
    legendType: 'categorical',
    legendClasses: [{ name: 'Boundary', 'color-hint': 'ff0000' }],
});

describe('MapManager legend grouping (#328)', () => {
    it('clusters same-group layers under one heading; ungrouped stays flat', async () => {
        const mm = createLegendManager({
            A: categorical('2021 restored', 'Bears Ears'),
            B: categorical('2026 proposed', 'Bears Ears'),
            C: categorical('Statewide layer', null),
        });
        await mm._showLegend('A');
        await mm._showLegend('B');
        await mm._showLegend('C');

        // One group wrapper for "Bears Ears" holding both member sections.
        const groups = mm._legendContent.querySelectorAll('.legend-group');
        expect(groups).toHaveLength(1);
        expect(groups[0].querySelector('.legend-group-title').textContent).toBe('Bears Ears');
        expect(groups[0].querySelectorAll('.legend-section')).toHaveLength(2);

        // Ungrouped section is a direct child of #legend-content, not inside a group.
        const flatSections = [...mm._legendContent.children].filter(el => el.classList.contains('legend-section'));
        expect(flatSections).toHaveLength(1);
        expect(flatSections[0].textContent).toContain('Statewide layer');
    });

    it('renders separate wrappers for distinct groups', async () => {
        const mm = createLegendManager({
            A: categorical('2021 restored', 'Bears Ears'),
            B: categorical('2021 restored', 'Grand Staircase-Escalante'),
        });
        await mm._showLegend('A');
        await mm._showLegend('B');
        expect(mm._legendContent.querySelectorAll('.legend-group')).toHaveLength(2);
        expect(mm._legendGroups.size).toBe(2);
    });

    it('hides the group heading only once every member is hidden, and restores it', async () => {
        const mm = createLegendManager({
            A: categorical('2021 restored', 'Bears Ears'),
            B: categorical('2026 proposed', 'Bears Ears'),
        });
        await mm._showLegend('A');
        await mm._showLegend('B');
        const wrapper = mm._legendGroups.get('Bears Ears');

        mm._hideLegend('A');
        expect(wrapper.style.display).not.toBe('none'); // B still visible

        mm._hideLegend('B');
        expect(wrapper.style.display).toBe('none'); // all hidden

        await mm._showLegend('A'); // reuse path re-shows the wrapper
        expect(wrapper.style.display).not.toBe('none');
    });

    it('escapes an untrusted group name (textContent, no HTML injection)', async () => {
        const mm = createLegendManager({
            A: categorical('2021 restored', '<img src=x onerror=alert(1)>'),
        });
        await mm._showLegend('A');
        const wrapper = mm._legendContent.querySelector('.legend-group');
        expect(wrapper.querySelector('img')).toBeNull();
        expect(wrapper.querySelector('.legend-group-title').textContent).toContain('<img');
    });
});
