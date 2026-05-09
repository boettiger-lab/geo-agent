import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DatasetCatalog } from '../app/dataset-catalog.js';

const stacCollection = (overrides = {}) => ({
    type: 'Collection',
    stac_version: '1.0.0',
    id: 'demo',
    title: 'Demo Collection',
    description: 'A demo',
    license: 'CC-BY-4.0',
    keywords: ['demo'],
    extent: { spatial: { bbox: [[-180, -90, 180, 90]] } },
    providers: [{ name: 'Demo Lab', roles: ['producer'] }],
    links: [],
    assets: {},
    'table:columns': [
        { name: 'id', type: 'string', description: 'unique id' },
        { name: 'value', type: 'double' },
        { name: 'geometry', type: 'binary' },  // should be filtered out
    ],
    ...overrides,
});

const mockFetchJson = (urlMap) => vi.fn(async (url) => {
    if (urlMap.has(url)) {
        return { ok: true, status: 200, json: async () => urlMap.get(url) };
    }
    return { ok: false, status: 404, json: async () => null };
});

describe('DatasetCatalog extractors', () => {
    const cat = new DatasetCatalog();

    it('extractColumns drops geometry/geom and defaults missing types to "string"', () => {
        const cols = cat.extractColumns(stacCollection({
            'table:columns': [
                { name: 'id', type: 'string' },
                { name: 'GEOM' },           // dropped (case-insensitive)
                { name: 'geometry', type: 'binary' },  // dropped
                { name: 'untyped' },        // type defaults to 'string'
                { name: 'state', values: ['CA', 'NV'] },  // values preserved
            ],
        }));
        expect(cols).toHaveLength(3);
        expect(cols.map(c => c.name)).toEqual(['id', 'untyped', 'state']);
        expect(cols.find(c => c.name === 'untyped').type).toBe('string');
        expect(cols.find(c => c.name === 'state').values).toEqual(['CA', 'NV']);
    });

    it('extractColumns returns empty when table:columns missing', () => {
        const cols = cat.extractColumns({ id: 'x' });
        expect(cols).toEqual([]);
    });

    it('extractProvider picks the first provider with role "producer"', () => {
        expect(cat.extractProvider({
            providers: [
                { name: 'Host Lab', roles: ['host'] },
                { name: 'Maker Lab', roles: ['producer'] },
                { name: 'Other Producer', roles: ['producer'] },
            ],
        })).toBe('Maker Lab');
    });

    it('extractProvider returns "Unknown" when none have producer role', () => {
        expect(cat.extractProvider({ providers: [{ name: 'Host', roles: ['host'] }] })).toBe('Unknown');
        expect(cat.extractProvider({})).toBe('Unknown');
    });

    it('extractAboutUrl finds rel=about, returns null otherwise', () => {
        expect(cat.extractAboutUrl({ links: [{ rel: 'about', href: 'https://x.dev' }] })).toBe('https://x.dev');
        expect(cat.extractAboutUrl({ links: [{ rel: 'self', href: 'https://x.dev' }] })).toBeNull();
        expect(cat.extractAboutUrl({})).toBeNull();
    });

    it('extractDocUrl matches both rel=describedby and rel=documentation', () => {
        expect(cat.extractDocUrl({ links: [{ rel: 'describedby', href: 'a' }] })).toBe('a');
        expect(cat.extractDocUrl({ links: [{ rel: 'documentation', href: 'b' }] })).toBe('b');
        expect(cat.extractDocUrl({ links: [{ rel: 'about', href: 'c' }] })).toBeNull();
    });

    it('extractParquetAssets converts NRP HTTPS URLs to s3:// and adds partition wildcard for trailing /', () => {
        const assets = cat.extractParquetAssets({
            assets: {
                pq: { type: 'application/vnd.apache.parquet', href: 'https://s3-west.nrp-nautilus.io/bucket/data.parquet', title: 'Data' },
                hex: { type: 'application/x-parquet', href: 'https://s3-west.nrp-nautilus.io/bucket/hex/' },
                ext: { href: 'https://other.example/file.parquet', title: 'Ext' },
                tile: { type: 'application/vnd.pmtiles', href: 'https://s3-west.nrp-nautilus.io/bucket/x.pmtiles' },
            },
        });
        const byId = Object.fromEntries(assets.map(a => [a.assetId, a]));

        expect(byId.pq.s3Path).toBe('s3://bucket/data.parquet');
        expect(byId.pq.isPartitioned).toBe(false);

        expect(byId.hex.s3Path).toBe('s3://bucket/hex/**');
        expect(byId.hex.isPartitioned).toBe(true);

        // Non-NRP host: original URL preserved
        expect(byId.ext.s3Path).toBe('https://other.example/file.parquet');

        // PMTiles is not a parquet asset
        expect(byId.tile).toBeUndefined();
    });
});

describe('DatasetCatalog public getters and toStacDict', () => {
    let cat;
    beforeEach(() => {
        cat = new DatasetCatalog();
        cat.datasets.set('a', { id: 'a', title: 'A', _rawStac: { id: 'a', stac_version: '1.0.0' } });
        cat.datasets.set('b', {
            id: 'b',
            title: 'B',
            _rawStac: { id: 'b', stac_version: '1.0.0' },
            _rawChildren: [{ id: 'b-child-1' }, { id: 'b-child-2' }],
        });
        cat.datasets.set('c', { id: 'c', title: 'C' });  // no _rawStac
    });

    it('get returns entry or null', () => {
        expect(cat.get('a').id).toBe('a');
        expect(cat.get('missing')).toBeNull();
    });

    it('getIds returns insertion order', () => {
        expect(cat.getIds()).toEqual(['a', 'b', 'c']);
    });

    it('getAll returns array of entries', () => {
        expect(cat.getAll().map(e => e.id)).toEqual(['a', 'b', 'c']);
    });

    it('toStacDict returns _rawStac when present, with children embedded if any', () => {
        expect(cat.toStacDict('a')).toEqual({ id: 'a', stac_version: '1.0.0' });
        expect(cat.toStacDict('b')).toEqual({
            id: 'b',
            stac_version: '1.0.0',
            children: [{ id: 'b-child-1' }, { id: 'b-child-2' }],
        });
    });

    it('toStacDict returns null when entry missing or has no _rawStac', () => {
        expect(cat.toStacDict('missing')).toBeNull();
        expect(cat.toStacDict('c')).toBeNull();
    });
});

describe('DatasetCatalog.generatePromptCatalog', () => {
    let cat;
    beforeEach(() => {
        cat = new DatasetCatalog();
    });

    it('renders a leaf entry with SQL paths and map layers', () => {
        cat.datasets.set('demo', {
            id: 'demo',
            title: 'Demo Layer',
            description: 'D desc',
            provider: 'Demo Lab',
            columns: [{ name: 'id', type: 'string' }],
            childIds: [],
            mapLayers: [{ assetId: 'pmtiles', title: 'Demo Vector', layerType: 'vector' }],
            parquetAssets: [{ title: 'Demo Parquet', s3Path: 's3://demo/data.parquet' }],
            aboutUrl: 'https://demo.example',
        });
        const out = cat.generatePromptCatalog();
        expect(out).toContain('### Demo Layer');
        expect(out).toContain('**Collection ID:** demo');
        expect(out).toContain('**Provider:** Demo Lab');
        expect(out).toContain("read_parquet('s3://demo/data.parquet')");
        expect(out).toContain('layer_id: `demo/pmtiles`');
        expect(out).toContain('https://demo.example');
    });

    it('renders a parent-container entry (no columns, has childIds) as a directory node', () => {
        cat.datasets.set('parent', {
            id: 'parent',
            title: 'Parent',
            description: 'P desc',
            provider: 'Lab',
            columns: [],
            childIds: ['c1', 'c2'],
            mapLayers: [],
            parquetAssets: [],
        });
        const out = cat.generatePromptCatalog();
        expect(out).toContain('Sub-datasets — call `get_stac_details`');
        expect(out).toContain('c1, c2');
        expect(out).not.toContain('SQL assets');
    });

    it('truncates childIds list at 20 with a "more" hint', () => {
        const ids = Array.from({ length: 25 }, (_, i) => `c${i}`);
        cat.datasets.set('big', {
            id: 'big', title: 'B', description: '', provider: '',
            columns: [], childIds: ids, mapLayers: [], parquetAssets: [],
        });
        const out = cat.generatePromptCatalog();
        expect(out).toContain('c0, c1, c2');
        expect(out).toContain('(5 more —');
        expect(out).not.toContain('c24,');
    });

    it('renders a layer with versions and a default_filter', () => {
        cat.datasets.set('vd', {
            id: 'vd', title: 'V', description: '', provider: 'L',
            columns: [{ name: 'x' }], childIds: [], parquetAssets: [],
            mapLayers: [{
                assetId: 'm',
                title: 'V layer',
                layerType: 'vector',
                versions: [{ label: 'L4' }, { label: 'L5' }],
                defaultFilter: ['==', ['get', 'kind'], 'forest'],
            }],
        });
        const out = cat.generatePromptCatalog();
        expect(out).toContain('[versions: L4, L5]');
        expect(out).toContain('[default filter:');
    });
});

describe('DatasetCatalog.load (mocked fetch)', () => {
    let originalFetch;
    beforeEach(() => {
        originalFetch = global.fetch;
    });
    afterEach(() => {
        global.fetch = originalFetch;
    });

    it('walks the root catalog, fetches matching child collections, and registers them', async () => {
        const root = {
            type: 'Catalog',
            id: 'root',
            links: [
                { rel: 'child', href: '/coll/wanted.json', id: 'wanted' },
                { rel: 'child', href: '/coll/skipped.json', id: 'skipped' },
            ],
        };
        const wanted = stacCollection({ id: 'wanted', title: 'Wanted' });
        const map = new Map([
            ['https://catalog.example/catalog.json', root],
            ['https://catalog.example/coll/wanted.json', wanted],
        ]);
        global.fetch = mockFetchJson(map);

        const cat = new DatasetCatalog();
        await cat.load({
            catalog: 'https://catalog.example/catalog.json',
            collections: ['wanted'],
        });

        // Pre-filter on link.id means we never fetch "skipped"
        const calledUrls = global.fetch.mock.calls.map(c => c[0]);
        expect(calledUrls).not.toContain('https://catalog.example/coll/skipped.json');
        expect(cat.get('wanted')).toBeTruthy();
        expect(cat.get('skipped')).toBeNull();
    });

    it('fetches direct collection_url overrides instead of walking the catalog', async () => {
        const root = { id: 'root', links: [] };  // no children
        const direct = stacCollection({ id: 'direct', title: 'Direct' });
        const map = new Map([
            ['https://x.example/catalog.json', root],
            ['https://other.example/private/direct.json', direct],
        ]);
        global.fetch = mockFetchJson(map);

        const cat = new DatasetCatalog();
        await cat.load({
            catalog: 'https://x.example/catalog.json',
            collections: [{ collection_id: 'direct', collection_url: 'https://other.example/private/direct.json' }],
        });

        expect(cat.get('direct')).toBeTruthy();
        expect(cat.get('direct').title).toBe('Direct');
    });

    it('warns when a requested collection is not found', async () => {
        const root = { id: 'root', links: [] };
        global.fetch = mockFetchJson(new Map([['https://x/c.json', root]]));
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const cat = new DatasetCatalog();
        await cat.load({ catalog: 'https://x/c.json', collections: ['ghost'] });

        const warnedAboutGhost = warnSpy.mock.calls.some(call =>
            call.join(' ').includes('Collection not found: ghost'));
        expect(warnedAboutGhost).toBe(true);
        warnSpy.mockRestore();
    });
});

describe('DatasetCatalog.extractMapLayers', () => {
    const cat = new DatasetCatalog();

    const collectionWithAssets = (assets) => stacCollection({ id: 'demo', title: 'Demo', assets });

    it('extracts a PMTiles asset as a vector layer with sourceLayer derived from vector:layers', () => {
        const layers = cat.extractMapLayers(collectionWithAssets({
            holdings: {
                type: 'application/vnd.pmtiles',
                href: 'https://x/holdings.pmtiles',
                title: 'Holdings',
                'vector:layers': ['holdings_layer'],
            },
        }), {}, [{ key: 'holdings', assetId: 'holdings', config: {} }]);

        expect(layers).toHaveLength(1);
        expect(layers[0].layerType).toBe('vector');
        expect(layers[0].url).toBe('https://x/holdings.pmtiles');
        expect(layers[0].sourceLayer).toBe('holdings_layer');
    });

    it('falls back to assetId for sourceLayer when vector:layers is absent', () => {
        const layers = cat.extractMapLayers(collectionWithAssets({
            tiles: { type: 'application/vnd.pmtiles', href: 'https://x/x.pmtiles' },
        }), {}, [{ key: 'tiles', assetId: 'tiles', config: {} }]);
        expect(layers[0].sourceLayer).toBe('tiles');
    });

    it('extracts a GeoTIFF asset as a raster layer with classification:classes when present', () => {
        const layers = cat.extractMapLayers(collectionWithAssets({
            cog: {
                type: 'image/tiff; application=geotiff',
                href: 'https://x/cog.tif',
                'raster:bands': [{
                    nodata: -9999,
                    'classification:classes': [{ value: 1, description: 'forest' }],
                }],
            },
        }), {}, [{ key: 'cog', assetId: 'cog', config: { colormap: 'viridis' } }]);

        expect(layers[0].layerType).toBe('raster');
        expect(layers[0].cogUrl).toBe('https://x/cog.tif');
        expect(layers[0].nodata).toBe(-9999);
        expect(layers[0].legendClasses).toEqual([{ value: 1, description: 'forest' }]);
        expect(layers[0].colormap).toBe('viridis');
    });

    it('extracts a versioned asset producing a single layer with versions[]', () => {
        const layers = cat.extractMapLayers(collectionWithAssets({
            l3: { type: 'application/vnd.pmtiles', href: 'https://x/l3.pmtiles' },
            l4: { type: 'application/vnd.pmtiles', href: 'https://x/l4.pmtiles' },
        }), {}, [{
            key: 'basins',
            assetId: 'basins',
            config: {
                display_name: 'Watersheds',
                versions: [
                    { label: 'L3', asset_id: 'l3' },
                    { label: 'L4', asset_id: 'l4' },
                ],
                default_version: 'L4',
            },
        }]);

        expect(layers).toHaveLength(1);
        expect(layers[0].title).toBe('Watersheds');
        expect(layers[0].versions).toHaveLength(2);
        expect(layers[0].defaultVersionIndex).toBe(1);
    });

    it('skips a versioned config whose asset_ids are all missing', () => {
        const layers = cat.extractMapLayers(collectionWithAssets({}), {}, [{
            key: 'basins',
            assetId: 'basins',
            config: { versions: [{ label: 'X', asset_id: 'absent' }] },
        }]);
        expect(layers).toHaveLength(0);
    });

    it('respects alias — same STAC asset can produce multiple logical layers', () => {
        const collection = collectionWithAssets({
            tiles: { type: 'application/vnd.pmtiles', href: 'https://x/all.pmtiles', 'vector:layers': ['all'] },
        });
        const layers = cat.extractMapLayers(collection, {}, [
            { key: 'fee', assetId: 'tiles', config: { display_name: 'Fee' } },
            { key: 'easement', assetId: 'tiles', config: { display_name: 'Easement', default_filter: ['==', 'kind', 'easement'] } },
        ]);
        expect(layers.map(l => l.assetId)).toEqual(['fee', 'easement']);
        // Both reference the same STAC source asset for source-sharing in MapLibre
        expect(layers.every(l => l.sourceAssetId === 'tiles')).toBe(true);
        expect(layers[1].defaultFilter).toEqual(['==', 'kind', 'easement']);
    });

    it('skips assets whose STAC entry is missing in filtered mode', () => {
        const layers = cat.extractMapLayers(collectionWithAssets({}), {}, [
            { key: 'ghost', assetId: 'ghost', config: {} },
        ]);
        expect(layers).toEqual([]);
    });
});

describe('DatasetCatalog.getMapLayerConfigs', () => {
    let cat;
    beforeEach(() => { cat = new DatasetCatalog(); });

    it('flattens vector layers with layerId="<datasetId>/<assetId>" and pmtiles:// source url', () => {
        cat.datasets.set('demo', {
            id: 'demo', title: 'Demo', columns: [],
            mapLayers: [
                { assetId: 'pmtiles', layerType: 'vector', title: 'Demo Vector', url: 'https://x/x.pmtiles', sourceLayer: 'x' },
            ],
        });
        const configs = cat.getMapLayerConfigs();
        expect(configs).toHaveLength(1);
        expect(configs[0]).toMatchObject({
            layerId: 'demo/pmtiles',
            datasetId: 'demo',
            type: 'vector',
            displayName: 'Demo Vector',
            sourceLayer: 'x',
        });
        expect(configs[0].source).toEqual({ type: 'vector', url: 'pmtiles://https://x/x.pmtiles' });
    });

    it('emits one entry per layer when one dataset has multiple', () => {
        cat.datasets.set('demo', {
            id: 'demo', title: 'Demo', columns: [],
            mapLayers: [
                { assetId: 'a', layerType: 'vector', title: 'A', url: 'https://x/a.pmtiles', sourceLayer: 'a' },
                { assetId: 'b', layerType: 'vector', title: 'B', url: 'https://x/b.pmtiles', sourceLayer: 'b' },
            ],
        });
        const configs = cat.getMapLayerConfigs();
        expect(configs.map(c => c.layerId)).toEqual(['demo/a', 'demo/b']);
    });

    it('builds a TiTiler tiles URL for raster layers with colormap_name + rescale', () => {
        cat.titilerUrl = 'https://titiler.example';
        cat.datasets.set('cogds', {
            id: 'cogds', title: 'C', columns: [],
            mapLayers: [{
                assetId: 'cog', layerType: 'raster', title: 'C',
                cogUrl: 'https://x/cog.tif',
                colormap: 'viridis',
                rescale: '0,100',
            }],
        });
        const [c] = cat.getMapLayerConfigs();
        expect(c.type).toBe('raster');
        const tile = c.source.tiles[0];
        expect(tile).toContain('https://titiler.example/cog/tiles');
        expect(tile).toContain('colormap_name=viridis');
        expect(tile).toContain('rescale=0,100');
    });

    it('emits an inline colormap JSON for categorical raster layers from classification:classes', () => {
        cat.titilerUrl = 'https://titiler.example';
        cat.datasets.set('cogds', {
            id: 'cogds', title: 'C', columns: [],
            mapLayers: [{
                assetId: 'cog', layerType: 'raster', title: 'C',
                cogUrl: 'https://x/cog.tif',
                legendType: 'categorical',
                legendClasses: [
                    { value: 1, 'color-hint': 'ff0000' },
                    { value: 2, color_hint: '00ff00' },
                ],
            }],
        });
        const [c] = cat.getMapLayerConfigs();
        const tile = c.source.tiles[0];
        expect(tile).toContain('colormap=');
        expect(tile).not.toContain('colormap_name=');
        const inlineCmap = decodeURIComponent(tile.match(/colormap=([^&]+)/)[1]);
        expect(JSON.parse(inlineCmap)).toEqual({
            '1': [255, 0, 0, 255],
            '2': [0, 255, 0, 255],
        });
    });
});

describe('DatasetCatalog.processCollection one-level child expansion', () => {
    let originalFetch;
    beforeEach(() => { originalFetch = global.fetch; });
    afterEach(() => { global.fetch = originalFetch; });

    it('captures childIds and rawChildren for inline forwarding', async () => {
        const child1 = stacCollection({ id: 'c1', 'table:columns': [{ name: 'a', type: 'string' }] });
        const child2 = stacCollection({ id: 'c2', 'table:columns': [{ name: 'b', type: 'int' }] });
        global.fetch = mockFetchJson(new Map([
            ['https://x/c1.json', child1],
            ['https://x/c2.json', child2],
        ]));

        const cat = new DatasetCatalog();
        cat.catalogUrl = 'https://x/catalog.json';

        const parent = stacCollection({
            id: 'parent',
            'table:columns': [],  // no columns of its own
            links: [
                { rel: 'child', href: 'c1.json' },
                { rel: 'child', href: 'c2.json' },
            ],
        });

        const entry = await cat.processCollection(parent);

        expect(entry.childIds.sort()).toEqual(['c1', 'c2']);
        expect(entry._rawChildren.map(c => c.id).sort()).toEqual(['c1', 'c2']);
        // Parent has no columns of its own → first non-empty child columns are used
        expect(entry.columns.length).toBeGreaterThan(0);
    });
});
