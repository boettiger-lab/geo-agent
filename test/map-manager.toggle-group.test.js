// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { MapManager } from '../app/map-manager.js';

/**
 * Toggle groups (#349): layers sharing a `toggleGroup` get one panel row whose
 * checkbox drives every member. Members stay independent layers (own source,
 * own stretch, own legend entry); only the row is shared. When members are
 * versioned, the row's dropdown keeps their versions in step, and a member
 * without the selected version is hidden and named in the row's note.
 */

function createManager() {
    const mm = Object.create(MapManager.prototype);
    mm.layers = new Map();
    const visibility = new Map();
    mm.map = {
        getSource: () => null, addSource: () => {}, getLayer: () => null,
        addLayer: (def) => visibility.set(def.id, def.layout.visibility),
        setLayoutProperty: (id, _prop, v) => visibility.set(id, v),
        setFilter: () => {},
    };
    mm._visibility = visibility;
    mm._wireTooltip = () => {};
    mm._showLegendIfVisible = () => {};
    mm._hasLegend = () => false;
    mm._refreshLegend = () => {};
    mm._promoteLegendType = () => {};
    mm._refreshCycleBtnState = () => {};
    return mm;
}

const raster = (layerId, displayName, extra = {}) => ({
    layerId, datasetId: layerId.split('/')[0], displayName, type: 'raster',
    source: { type: 'raster', tiles: [`https://t/${layerId}`] }, paint: {}, ...extra,
});

const versioned = (layerId, displayName, labels, extra = {}) => ({
    layerId, datasetId: layerId.split('/')[0], displayName, type: 'raster', paint: {},
    versions: labels.map(label => ({
        label, type: 'raster', sourceId: `src-${layerId}-${label}`,
        source: { type: 'raster', tiles: [`https://t/${layerId}/${label}`] },
    })),
    defaultVersionIndex: 0,
    ...extra,
});

const rows = (container) => [...container.querySelectorAll('.layer-item')];
const click = (checkbox) => checkbox.dispatchEvent(new Event('change'));

describe('MapManager toggle groups (#349)', () => {
    let mm, container;
    beforeEach(() => {
        mm = createManager();
        container = document.createElement('div');
    });

    it('renders members as one row, in the first member\'s place', () => {
        mm.registerLayer(raster('other/cog', 'Other'));
        mm.registerLayer(raster('whp-conus/cog', 'WHP (CONUS)', { toggleGroup: 'WHP 2023', rescale: '0,2000' }));
        mm.registerLayer(raster('mid/cog', 'Middle'));
        mm.registerLayer(raster('whp-ak/cog', 'WHP (Alaska)', { toggleGroup: 'WHP 2023', rescale: '0,9000' }));
        mm.generateControls(container);

        const labels = rows(container).map(r => r.querySelector('label span').textContent);
        expect(labels).toEqual(['Other', 'WHP 2023', 'Middle']);
        // Each member keeps its own layer state and stretch.
        expect(mm.layers.get('whp-conus/cog').rescale).toBe('0,2000');
        expect(mm.layers.get('whp-ak/cog').rescale).toBe('0,9000');
    });

    it('checking the row shows every member; unchecking hides them', () => {
        mm.registerLayer(raster('a/cog', 'A', { toggleGroup: 'G' }));
        mm.registerLayer(raster('b/cog', 'B', { toggleGroup: 'G' }));
        mm.generateControls(container);
        const cb = container.querySelector('#toggle-tg-g');

        cb.checked = true; click(cb);
        expect(mm.layers.get('a/cog').visible).toBe(true);
        expect(mm.layers.get('b/cog').visible).toBe(true);
        expect(mm._visibility.get('layer-b-cog')).toBe('visible');

        cb.checked = false; click(cb);
        expect(mm.layers.get('a/cog').visible).toBe(false);
        expect(mm.layers.get('b/cog').visible).toBe(false);
    });

    it('goes indeterminate when the agent shows only one half, and checked when both', () => {
        mm.registerLayer(raster('a/cog', 'A', { toggleGroup: 'G' }));
        mm.registerLayer(raster('b/cog', 'B', { toggleGroup: 'G' }));
        mm.generateControls(container);
        const cb = container.querySelector('#toggle-tg-g');

        mm.showLayer('b/cog'); mm.syncCheckbox('b/cog');
        expect(cb.checked).toBe(false);
        expect(cb.indeterminate).toBe(true);

        mm.showLayer('a/cog'); mm.syncCheckbox('a/cog');
        expect(cb.checked).toBe(true);
        expect(cb.indeterminate).toBe(false);
    });

    it('a group with one panel member renders as that member\'s normal row', () => {
        mm.registerLayer(raster('a/cog', 'A', { toggleGroup: 'G' }));
        mm.registerLayer(raster('b/cog', 'B', { toggleGroup: 'G', sidebar: false }));
        mm.generateControls(container);
        expect(rows(container).map(r => r.id)).toEqual(['layer-item-a-cog']);
    });

    it('starts checked when every member is visible on load', () => {
        mm.registerLayer(raster('a/cog', 'A', { toggleGroup: 'G', defaultVisible: true }));
        mm.registerLayer(raster('b/cog', 'B', { toggleGroup: 'G', defaultVisible: true }));
        mm.generateControls(container);
        expect(container.querySelector('#toggle-tg-g').checked).toBe(true);
    });

    it('renaming a member via set_legend leaves the shared row label alone', () => {
        mm.registerLayer(raster('a/cog', 'A', { toggleGroup: 'G' }));
        mm.registerLayer(raster('b/cog', 'B', { toggleGroup: 'G' }));
        mm.generateControls(container);
        document.body.appendChild(container);
        try {
            mm.setLegend('a/cog', { title: 'Renamed A' });
            expect(container.querySelector('.layer-toggle-group label span').textContent).toBe('G');
            expect(mm.layers.get('a/cog').displayName).toBe('Renamed A');
        } finally {
            container.remove();
        }
    });

    describe('versioned members', () => {
        beforeEach(() => {
            mm.registerLayer(versioned('mtbs-conus/sev', 'MTBS (CONUS)', ['1984', '1985', '1986'], { toggleGroup: 'MTBS' }));
            mm.registerLayer(versioned('mtbs-ak/sev', 'MTBS (Alaska)', ['1984', '1986', '1987'], { toggleGroup: 'MTBS' }));
            mm.generateControls(container);
        });

        it('shows one dropdown over the union of labels, in order', () => {
            const opts = [...container.querySelectorAll('select.version-select option')].map(o => o.value);
            expect(opts).toEqual(['1984', '1985', '1986', '1987']);
            expect(container.querySelectorAll('select.version-select')).toHaveLength(1);
        });

        it('picking a version switches every member that has it', () => {
            mm.switchToggleGroupVersion('MTBS', '1986');
            expect(mm.layers.get('mtbs-conus/sev').activeVersionIndex).toBe(2);
            expect(mm.layers.get('mtbs-ak/sev').activeVersionIndex).toBe(1);
        });

        it('hides a member without the selected version, names it, and restores it later', () => {
            const cb = container.querySelector('#toggle-tg-mtbs');
            const note = container.querySelector('.toggle-group-note');
            cb.checked = true; click(cb);

            const res = mm.switchToggleGroupVersion('MTBS', '1985');
            expect(res.unavailable).toEqual(['mtbs-ak/sev']);
            expect(mm.layers.get('mtbs-conus/sev').visible).toBe(true);
            expect(mm.layers.get('mtbs-ak/sev').visible).toBe(false);
            expect(note.hidden).toBe(false);
            expect(note.textContent).toContain('MTBS (Alaska)');
            // Every member that has 1985 is on, so the row reads as on.
            expect(cb.checked).toBe(true);
            expect(cb.indeterminate).toBe(false);

            mm.switchToggleGroupVersion('MTBS', '1986');
            expect(mm.layers.get('mtbs-ak/sev').visible).toBe(true);
            expect(mm.layers.get('mtbs-ak/sev').activeVersionIndex).toBe(1);
            expect(note.hidden).toBe(true);
        });

        it('does not resurrect a member the agent hid on purpose', () => {
            const cb = container.querySelector('#toggle-tg-mtbs');
            cb.checked = true; click(cb);
            mm.hideLayer('mtbs-ak/sev'); mm.syncCheckbox('mtbs-ak/sev');

            mm.switchToggleGroupVersion('MTBS', '1986');
            expect(mm.layers.get('mtbs-ak/sev').visible).toBe(false);
            expect(cb.indeterminate).toBe(true);
        });

        it('checking the row while a member lacks the version leaves that member off', () => {
            mm.switchToggleGroupVersion('MTBS', '1987');
            const cb = container.querySelector('#toggle-tg-mtbs');
            cb.checked = true; click(cb);
            expect(mm.layers.get('mtbs-conus/sev').visible).toBe(false);
            expect(mm.layers.get('mtbs-ak/sev').visible).toBe(true);
            expect(cb.checked).toBe(true);

            // ...and it comes back when a version it has is picked.
            mm.switchToggleGroupVersion('MTBS', '1984');
            expect(mm.layers.get('mtbs-conus/sev').visible).toBe(true);
        });
    });

    it('aligns members whose default versions differ onto the row\'s label', () => {
        mm.registerLayer(versioned('c/sev', 'C', ['1984', '1985'], { toggleGroup: 'M', defaultVersionIndex: 1 }));
        mm.registerLayer(versioned('a/sev', 'A', ['1984', '1985'], { toggleGroup: 'M', defaultVersionIndex: 0 }));
        mm.generateControls(container);
        expect(mm.layers.get('a/sev').activeVersionIndex).toBe(1);
        expect(container.querySelector('select.version-select').value).toBe('1985');
    });

    it('rejects an unknown toggle group', () => {
        expect(mm.switchToggleGroupVersion('nope', '1984').success).toBe(false);
    });
});

describe('MapManager toggle-group legends (#349)', () => {
    let mm, container;

    // Real legend code over a stub map; only the overlay mount and the
    // TiTiler colormap fetch are faked.
    function createLegendManager() {
        const m = createManager();
        delete m._hasLegend;
        delete m._refreshLegend;
        delete m._showLegendIfVisible;
        m._legendEl = document.createElement('div');
        m._legendContent = document.createElement('div');
        m._legendItems = new Map();
        m._legendGroups = new Map();
        m._hexLegendRefs = new Map();
        m._ensureLegend = () => {};
        m._getColormapGradient = async () => 'linear-gradient(red, blue)';
        return m;
    }

    const classes = [
        { value: 1, name: 'Low', 'color-hint': '006400' },
        { value: 4, name: 'High', 'color-hint': 'ff0000' },
    ];
    const shownSections = () => [...mm._legendContent.querySelectorAll('.legend-section')]
        .filter(el => el.style.display !== 'none');
    const titles = () => shownSections().map(el => el.querySelector('h4')?.textContent);
    const flush = () => new Promise(r => setTimeout(r, 0));

    beforeEach(() => {
        mm = createLegendManager();
        container = document.createElement('div');
    });

    describe('identical categorical legends (MTBS)', () => {
        beforeEach(() => {
            const cat = { toggleGroup: 'MTBS', group: 'Fire history', legendType: 'categorical', legendClasses: classes };
            mm.registerLayer(versioned('conus/sev', 'MTBS (CONUS)', ['1984', '1985'], cat));
            mm.registerLayer(versioned('ak/sev', 'MTBS (Alaska)', ['1984'], cat));
            mm.generateControls(container);
        });

        it('share one section titled with the group name', () => {
            mm._setToggleGroupVisible(mm._toggleGroups.get('MTBS'), true);
            expect(titles()).toEqual(['MTBS']);
        });

        it('fall back to the remaining member\'s own title when one half drops out', () => {
            mm._setToggleGroupVisible(mm._toggleGroups.get('MTBS'), true);
            mm.switchToggleGroupVersion('MTBS', '1985');   // Alaska has no 1985
            expect(titles()).toEqual(['MTBS (CONUS)']);

            mm.switchToggleGroupVersion('MTBS', '1984');
            expect(titles()).toEqual(['MTBS']);
        });

        it('hand the section to the other member when the owner is hidden', () => {
            mm._setToggleGroupVisible(mm._toggleGroups.get('MTBS'), true);
            mm.hideLayer('conus/sev');
            expect(titles()).toEqual(['MTBS (Alaska)']);
            mm.showLayer('conus/sev');
            expect(titles()).toEqual(['MTBS']);
        });

        it('split again when the agent relabels one member\'s classes', () => {
            mm._setToggleGroupVisible(mm._toggleGroups.get('MTBS'), true);
            mm.setLegend('ak/sev', { labels: { 4: 'Severe' } });
            expect(titles()).toEqual(['MTBS (CONUS)', 'MTBS (Alaska)']);
        });
    });

    it('keeps separate colorbars when the stretches differ (WHP)', async () => {
        mm.registerLayer(raster('conus/cog', 'WHP (CONUS)', { toggleGroup: 'WHP', rescale: '0,2000', colormap: 'inferno' }));
        mm.registerLayer(raster('ak/cog', 'WHP (Alaska)', { toggleGroup: 'WHP', rescale: '0,9000', colormap: 'inferno' }));
        mm.generateControls(container);
        mm._setToggleGroupVisible(mm._toggleGroups.get('WHP'), true);
        await flush();
        expect(titles()).toEqual(['WHP (CONUS)', 'WHP (Alaska)']);
    });

    it('merges colorbars with the same colormap and range', async () => {
        mm.registerLayer(raster('a/cog', 'A', { toggleGroup: 'G', rescale: '0,1', colormap: 'reds' }));
        mm.registerLayer(raster('b/cog', 'B', { toggleGroup: 'G', rescale: '0,1', colormap: 'reds' }));
        mm.generateControls(container);
        mm._setToggleGroupVisible(mm._toggleGroups.get('G'), true);
        await flush();
        expect(titles()).toEqual(['G']);
    });

    it('leaves legends of layers outside any toggle group alone', async () => {
        mm.registerLayer(raster('a/cog', 'A', { rescale: '0,1' }));
        mm.registerLayer(raster('b/cog', 'B', { rescale: '0,1' }));
        mm.generateControls(container);
        mm.showLayer('a/cog'); mm.showLayer('b/cog');
        await flush();
        expect(titles()).toEqual(['A', 'B']);
    });
});
