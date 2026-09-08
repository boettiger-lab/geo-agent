// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { MapManager } from '../app/map-manager.js';

/**
 * Panel-membership flag (#352): `sidebar: false` keeps a layer fully registered
 * — the agent can still show, style and filter it — but omits its row from the
 * layer panel. Only `generateControls` / `_addLayerControl` honour it; the
 * layer registry and the legend must not.
 */

function createPanelManager(states) {
    const mm = Object.create(MapManager.prototype);
    mm.layers = new Map(Object.entries(states));
    mm._refreshCycleBtnState = () => {};
    return mm;
}

const layer = (displayName, extra = {}) => ({
    displayName, visible: false, versions: null, group: null, groupCollapsed: false, ...extra,
});

const rowIds = (container) =>
    [...container.querySelectorAll('.layer-item')].map(el => el.id.replace('layer-item-', ''));

describe('MapManager sidebar flag (#352)', () => {
    it('omits sidebar:false rows and keeps the rest, in order', () => {
        const mm = createPanelManager({
            a: layer('Shown A'),
            b: layer('Hidden B', { sidebar: false }),
            c: layer('Shown C', { sidebar: true }),
        });
        const container = document.createElement('div');
        mm.generateControls(container);

        expect(rowIds(container)).toEqual(['a', 'c']);
        // Registry is untouched — the agent can still address the hidden layer.
        expect(mm.layers.has('b')).toBe(true);
    });

    it('treats a state with no sidebar field as a panel member', () => {
        const mm = createPanelManager({ a: layer('Runtime hex layer') });
        delete mm.layers.get('a').sidebar;
        const container = document.createElement('div');
        mm.generateControls(container);
        expect(rowIds(container)).toEqual(['a']);
    });

    it('renders no empty <details> when every member of a group is panel-hidden', () => {
        const mm = createPanelManager({
            a: layer('Ungrouped'),
            b: layer('WOA23 salinity', { group: 'Reference rasters', sidebar: false }),
            c: layer('WOA23 oxygen', { group: 'Reference rasters', sidebar: false }),
        });
        const container = document.createElement('div');
        mm.generateControls(container);

        expect(container.querySelectorAll('details.layer-group')).toHaveLength(0);
        expect(rowIds(container)).toEqual(['a']);
    });

    it('keeps a partly-hidden group, reading collapsed state from a surviving entry', () => {
        const mm = createPanelManager({
            a: layer('Hidden first', { group: 'Bio-ORACLE', groupCollapsed: false, sidebar: false }),
            b: layer('Shown second', { group: 'Bio-ORACLE', groupCollapsed: true }),
        });
        const container = document.createElement('div');
        mm.generateControls(container);

        const details = container.querySelectorAll('details.layer-group');
        expect(details).toHaveLength(1);
        expect(details[0].querySelector('summary').textContent).toBe('Bio-ORACLE');
        // groupCollapsed comes from `b`, the first *surviving* entry, not `a`.
        expect(details[0].open).toBe(false);
        expect(rowIds(container)).toEqual(['b']);
    });

    it('_addLayerControl refuses to add a row for a sidebar:false layer', () => {
        const mm = createPanelManager({ hidden: layer('Hidden', { sidebar: false }) });
        mm._controlsContainerEl = document.createElement('div');
        mm._addLayerControl('hidden');
        expect(rowIds(mm._controlsContainerEl)).toEqual([]);
    });

    it('registerLayer stores sidebar on the layer state, defaulting to true', () => {
        const mm = Object.create(MapManager.prototype);
        mm.layers = new Map();
        mm.map = {
            getSource: () => null, addSource: () => {}, addLayer: () => {},
            getLayer: () => null, setLayoutProperty: () => {},
        };
        mm._wireTooltip = () => {};
        mm._showLegendIfVisible = () => {};

        const base = { datasetId: 'ds', type: 'vector', sourceId: 's', source: { type: 'vector' }, paint: {} };
        mm.registerLayer({ ...base, layerId: 'a', displayName: 'A' });
        mm.registerLayer({ ...base, layerId: 'b', displayName: 'B', sidebar: false });
        mm.registerLayer({ ...base, layerId: 'c', displayName: 'C', sidebar: true });

        expect(mm.layers.get('a').sidebar).toBe(true);
        expect(mm.layers.get('b').sidebar).toBe(false);
        expect(mm.layers.get('c').sidebar).toBe(true);
    });

    it('gives a panel-hidden layer its legend section, group heading and all', async () => {
        const mm = createPanelManager({
            a: layer('Seafloor carbon flux', {
                group: 'Reference rasters', sidebar: false, visible: true,
                legendType: 'categorical',
                legendClasses: [{ name: 'Low', 'color-hint': 'ff0000' }, { name: 'High', 'color-hint': '00ff00' }],
            }),
        });
        mm._legendEl = document.createElement('div');
        mm._legendContent = document.createElement('div');
        mm._legendItems = new Map();
        mm._legendGroups = new Map();
        mm._ensureLegend = () => {};

        await mm._showLegend('a');

        const group = mm._legendContent.querySelector('.legend-group');
        expect(group).not.toBeNull();
        expect(group.querySelector('.legend-group-title').textContent).toBe('Reference rasters');
        expect(mm._legendItems.has('a')).toBe(true);
    });
});
