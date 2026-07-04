import { describe, it, expect, vi, afterEach } from 'vitest';
import { extractJsonArray, createMapTools, createRenderChartTool } from '../app/map-tools.js';

describe('extractJsonArray', () => {
    it('parses to_json(array_agg(...)) output', () => {
        expect(extractJsonArray('[1,2,3]')).toEqual([1, 2, 3]);
    });

    it('parses array wrapped in markdown table cell', () => {
        const text = '| ids |\n|-----|\n| [10,20,30] |';
        expect(extractJsonArray(text)).toEqual([10, 20, 30]);
    });

    it('parses string IDs', () => {
        expect(extractJsonArray('["a","b","c"]')).toEqual(['a', 'b', 'c']);
    });

    it('handles empty array', () => {
        expect(extractJsonArray('[]')).toEqual([]);
    });

    // Pin down the bug fixed by #180: DuckDB's native array display format
    // (space-separated, no commas) is not valid JSON. The fix wraps SQL in
    // to_json(); this test ensures the parser correctly rejects the raw form
    // so a future regression in the SQL wrapping layer surfaces here.
    it('returns null on DuckDB native array display (space-separated, no commas)', () => {
        expect(extractJsonArray('[ 1  2  3]')).toBeNull();
    });

    it('returns null when no brackets present', () => {
        expect(extractJsonArray('no array here')).toBeNull();
    });

    it('returns null on malformed JSON between brackets', () => {
        expect(extractJsonArray('[1, 2, ]')).toBeNull();
    });
});

describe('filter_by_query', () => {
    const stubMapManager = () => {
        const setFilterCalls = [];
        return {
            setFilter: vi.fn((layerId, filter) => {
                setFilterCalls.push({ layerId, filter });
                return { success: true, featuresInView: 42 };
            }),
            getLayerSummaries: () => [
                { id: 'parcels', displayName: 'Parcels', type: 'vector' },
            ],
            _setFilterCalls: setFilterCalls,
        };
    };

    const stubCatalog = () => ({
        records: new Map(),
    });

    const getFilterTool = (mapManager, mcpClient) => {
        const tools = createMapTools(mapManager, stubCatalog(), mcpClient);
        return tools.find(t => t.name === 'filter_by_query');
    };

    it('returns success with idCount: 0 and does not call setFilter when query returns null', async () => {
        const mapManager = stubMapManager();
        const mcpClient = { callTool: vi.fn(async () => '| ids |\n|------|\n| NULL |') };
        const tool = getFilterTool(mapManager, mcpClient);

        const raw = await tool.execute({ layer_id: 'parcels', sql: 'SELECT id FROM x', id_property: 'id' });
        const result = JSON.parse(raw);

        expect(result.success).toBe(true);
        expect(result.idCount).toBe(0);
        expect(mapManager.setFilter).not.toHaveBeenCalled();
    });

    it('calls setFilter with [in, [get, col], [literal, ids]] on valid JSON array result', async () => {
        const mapManager = stubMapManager();
        const mcpClient = { callTool: vi.fn(async () => '[100,200,300]') };
        const tool = getFilterTool(mapManager, mcpClient);

        const raw = await tool.execute({ layer_id: 'parcels', sql: 'SELECT id FROM x', id_property: 'OBJECTID' });
        const result = JSON.parse(raw);

        expect(result.success).toBe(true);
        expect(result.idCount).toBe(3);
        expect(mapManager.setFilter).toHaveBeenCalledOnce();
        const [layerId, filter] = mapManager.setFilter.mock.calls[0];
        expect(layerId).toBe('parcels');
        expect(filter).toEqual(['in', ['get', 'OBJECTID'], ['literal', [100, 200, 300]]]);
    });

    it('returns success with idCount: 0 when query returns empty array', async () => {
        const mapManager = stubMapManager();
        const mcpClient = { callTool: vi.fn(async () => '[]') };
        const tool = getFilterTool(mapManager, mcpClient);

        const raw = await tool.execute({ layer_id: 'parcels', sql: 'SELECT id FROM x', id_property: 'id' });
        const result = JSON.parse(raw);

        expect(result.success).toBe(true);
        expect(result.idCount).toBe(0);
        expect(mapManager.setFilter).not.toHaveBeenCalled();
    });

    it('returns {success: false, error} when MCP throws', async () => {
        const mapManager = stubMapManager();
        const mcpClient = { callTool: vi.fn(async () => { throw new Error('MCP timeout'); }) };
        const tool = getFilterTool(mapManager, mcpClient);

        const raw = await tool.execute({ layer_id: 'parcels', sql: 'SELECT id FROM x', id_property: 'id' });
        const result = JSON.parse(raw);

        expect(result.success).toBe(false);
        expect(result.error).toContain('MCP timeout');
        expect(mapManager.setFilter).not.toHaveBeenCalled();
    });

    it('returns parse error when raw result is unparseable (e.g., wrong column name)', async () => {
        const mapManager = stubMapManager();
        const mcpClient = { callTool: vi.fn(async () => '[ 1  2  3]') }; // DuckDB native format
        const tool = getFilterTool(mapManager, mcpClient);

        const raw = await tool.execute({ layer_id: 'parcels', sql: 'SELECT id FROM x', id_property: 'BAD_COL' });
        const result = JSON.parse(raw);

        expect(result.success).toBe(false);
        expect(result.error).toContain('Could not parse ID list');
        expect(mapManager.setFilter).not.toHaveBeenCalled();
    });

    it('rejects id_property containing SQL metacharacters without calling MCP', async () => {
        const mapManager = stubMapManager();
        const mcpClient = { callTool: vi.fn(async () => '[1]') };
        const tool = getFilterTool(mapManager, mcpClient);

        const raw = await tool.execute({
            layer_id: 'parcels',
            sql: 'SELECT id FROM x',
            id_property: 'id") IS NOT NULL)) AS ids FROM evil --',
        });
        const result = JSON.parse(raw);

        expect(result.success).toBe(false);
        expect(result.error).toContain('id_property');
        expect(mcpClient.callTool).not.toHaveBeenCalled();
        expect(mapManager.setFilter).not.toHaveBeenCalled();
    });

    it('accepts underscore-prefixed and uppercase identifiers (_cng_fid, OBJECTID)', async () => {
        for (const col of ['_cng_fid', 'OBJECTID', 'GEOID20']) {
            const mapManager = stubMapManager();
            const mcpClient = { callTool: vi.fn(async () => '[1,2]') };
            const tool = getFilterTool(mapManager, mcpClient);

            const raw = await tool.execute({ layer_id: 'parcels', sql: 'SELECT id FROM x', id_property: col });
            const result = JSON.parse(raw);

            expect(result.success).toBe(true);
            expect(mcpClient.callTool).toHaveBeenCalledOnce();
        }
    });
});

describe('list_datasets', () => {
    it('returns the catalog ids and titles', () => {
        const stubMapManager = { getLayerSummaries: () => [], setFilter: () => ({}) };
        const stubCatalog = {
            records: new Map(),
            getAll: () => [
                { id: 'a', title: 'Alpha' },
                { id: 'b', title: 'Bravo' },
            ],
        };
        const tools = createMapTools(stubMapManager, stubCatalog);
        const tool = tools.find(t => t.name === 'list_datasets');
        const result = JSON.parse(tool.execute());
        expect(result.success).toBe(true);
        expect(result.datasets).toEqual([
            { id: 'a', title: 'Alpha' },
            { id: 'b', title: 'Bravo' },
        ]);
    });
});

describe('set_projection', () => {
    it('forwards the requested type to mapManager.setProjection', () => {
        const calls = [];
        const stubMapManager = {
            getLayerSummaries: () => [], setFilter: () => ({}),
            setProjection: (t) => { calls.push(t); },
        };
        const tools = createMapTools(stubMapManager, { records: new Map() });
        const tool = tools.find(t => t.name === 'set_projection');
        const result = JSON.parse(tool.execute({ type: 'globe' }));
        expect(calls).toEqual(['globe']);
        expect(result.projection).toBe('globe');
    });
});

describe('get_schema MCP delegate', () => {
    const stubMap = { getLayerSummaries: () => [], setFilter: () => ({}) };

    const stubCatalog = (rawStac) => ({
        records: new Map(),
        get: (id) => (id === 'demo' ? { id: 'demo' } : null),
        getIds: () => ['demo'],
        toStacDict: (id) => (id === 'demo' ? rawStac : null),
    });

    it('forwards { dataset_id, collection } inline to MCP and returns the result', async () => {
        const inline = { id: 'demo', stac_version: '1.0.0' };
        const callTool = vi.fn(async () => 'schema-text');
        const tools = createMapTools(stubMap, stubCatalog(inline), { callTool });
        const tool = tools.find(t => t.name === 'get_schema');

        const out = await tool.execute({ dataset_id: 'demo' });

        expect(out).toBe('schema-text');
        expect(callTool).toHaveBeenCalledWith('get_stac_details', { dataset_id: 'demo', collection: inline });
    });

    it('returns a structured error when the dataset is not in the catalog', async () => {
        const tools = createMapTools(stubMap, stubCatalog({}), { callTool: vi.fn() });
        const tool = tools.find(t => t.name === 'get_schema');
        const result = JSON.parse(await tool.execute({ dataset_id: 'absent' }));
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/not found/i);
    });

    it('returns a structured error when MCP throws', async () => {
        const callTool = vi.fn(async () => { throw new Error('mcp down'); });
        const tools = createMapTools(stubMap, stubCatalog({ id: 'demo' }), { callTool });
        const tool = tools.find(t => t.name === 'get_schema');
        const result = JSON.parse(await tool.execute({ dataset_id: 'demo' }));
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/mcp down/);
    });

    it('returns a structured error when no MCP client is configured', async () => {
        const tools = createMapTools(stubMap, stubCatalog({ id: 'demo' }));
        const tool = tools.find(t => t.name === 'get_schema');
        const result = JSON.parse(await tool.execute({ dataset_id: 'demo' }));
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/unavailable/i);
    });
});

describe('set_tooltip / reset_tooltip', () => {
    const stubMapManager = () => ({
        setTooltip: vi.fn((layerId, fields) => ({ success: true, layer: layerId, tooltipFields: fields })),
        resetTooltip: vi.fn((layerId) => ({ success: true, layer: layerId, tooltipFields: ['name'] })),
        getLayerSummaries: () => [
            { id: 'parcels', displayName: 'Parcels', type: 'vector' },
            { id: 'irrecoverable', displayName: 'Irrecoverable Carbon', type: 'raster' },
        ],
    });
    const stubCatalog = { records: new Map() };

    const getTool = (name) => {
        const mapManager = stubMapManager();
        const tools = createMapTools(mapManager, stubCatalog);
        return { tool: tools.find(t => t.name === name), mapManager };
    };

    it('set_tooltip forwards (layer_id, fields) to mapManager.setTooltip', () => {
        const { tool, mapManager } = getTool('set_tooltip');
        const result = JSON.parse(tool.execute({ layer_id: 'parcels', fields: ['name', 'gap_code'] }));
        expect(result.success).toBe(true);
        expect(mapManager.setTooltip).toHaveBeenCalledWith('parcels', ['name', 'gap_code']);
    });

    it('set_tooltip with empty array disables the tooltip', () => {
        const { tool, mapManager } = getTool('set_tooltip');
        tool.execute({ layer_id: 'parcels', fields: [] });
        expect(mapManager.setTooltip).toHaveBeenCalledWith('parcels', []);
    });

    it('reset_tooltip forwards layer_id to mapManager.resetTooltip', () => {
        const { tool, mapManager } = getTool('reset_tooltip');
        const result = JSON.parse(tool.execute({ layer_id: 'parcels' }));
        expect(result.success).toBe(true);
        expect(mapManager.resetTooltip).toHaveBeenCalledWith('parcels');
    });

    it('tool descriptions do NOT embed the layer list (#225)', () => {
        // The live roster is injected once via the system-prompt catalog, not
        // re-embedded per tool. Descriptions must not name any layer.
        for (const name of ['set_tooltip', 'show_layer', 'set_filter', 'set_style', 'filter_by_query']) {
            const { tool } = getTool(name);
            if (!tool) continue;
            expect(tool.description, name).not.toMatch(/Parcels/);
            expect(tool.description, name).not.toMatch(/Irrecoverable Carbon/);
            expect(tool.description, name).not.toMatch(/Available layers:|Vector layers:/);
        }
    });

    it('disambiguation nudge stays on layer-targeting tools', () => {
        const { tool } = getTool('set_tooltip');
        expect(tool.description).toMatch(/displayName semantic match/);
    });
});

describe('render_chart (#277)', () => {
    const stubRenderer = () => {
        const calls = [];
        return { render: vi.fn(async (spec, rows) => { calls.push({ spec, rows }); return { id: 'chart-1' }; }), _calls: calls };
    };

    it('renders directly from an inline data array', async () => {
        const renderer = stubRenderer();
        const tool = createRenderChartTool(renderer, null);
        const data = [{ country: 'Brazil', pct: 31 }];
        const result = JSON.parse(await tool.execute({ chart_type: 'bar', x: 'country', y: 'pct', data }));
        expect(result.success).toBe(true);
        expect(result.chart_id).toBe('chart-1');
        expect(result.points).toBe(1);
        expect(renderer.render).toHaveBeenCalledOnce();
        expect(renderer.render.mock.calls[0][1]).toBe(data);
    });

    it('runs the sql path through MCP and parses rows', async () => {
        const renderer = stubRenderer();
        const mcpClient = { callTool: vi.fn(async () => '[{"country":"Brazil","pct":31},{"country":"Peru","pct":22}]') };
        const tool = createRenderChartTool(renderer, mcpClient);
        const result = JSON.parse(await tool.execute({ chart_type: 'bar', x: 'country', y: 'pct', sql: 'SELECT country, pct FROM t' }));
        expect(result.success).toBe(true);
        expect(result.points).toBe(2);
        // SQL is wrapped to aggregate rows to a JSON array
        expect(mcpClient.callTool.mock.calls[0][1].sql_query).toMatch(/to_json\(array_agg/);
    });

    it('errors when neither data nor sql is provided', async () => {
        const tool = createRenderChartTool(stubRenderer(), null);
        const result = JSON.parse(await tool.execute({ chart_type: 'bar', x: 'country', y: 'pct' }));
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/No data/);
    });

    it('errors on the sql path when no MCP client is available', async () => {
        const tool = createRenderChartTool(stubRenderer(), null);
        const result = JSON.parse(await tool.execute({ chart_type: 'bar', x: 'c', y: 'v', sql: 'SELECT 1' }));
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/MCP client not available/);
    });

    it('reports a render failure instead of throwing', async () => {
        const renderer = { render: vi.fn(async () => { throw new Error('boom'); }) };
        const tool = createRenderChartTool(renderer, null);
        const result = JSON.parse(await tool.execute({ chart_type: 'bar', x: 'c', y: 'v', data: [{ c: 'a', v: 1 }] }));
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/Could not render chart/);
    });

    it('rejects an invalid spec before running any SQL', async () => {
        const renderer = stubRenderer();
        const mcpClient = { callTool: vi.fn() };
        const tool = createRenderChartTool(renderer, mcpClient);
        // bar with no y → invalid; must not reach the MCP query
        const result = JSON.parse(await tool.execute({ chart_type: 'bar', x: 'c', sql: 'SELECT 1' }));
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/requires a y/);
        expect(mcpClient.callTool).not.toHaveBeenCalled();
    });

    it('reports an empty SQL result as "no rows", not a parse error', async () => {
        const renderer = stubRenderer();
        // DuckDB array_agg over zero rows → NULL
        const mcpClient = { callTool: vi.fn(async () => '| rows |\n|------|\n| NULL |') };
        const tool = createRenderChartTool(renderer, mcpClient);
        const result = JSON.parse(await tool.execute({ chart_type: 'bar', x: 'c', y: 'v', sql: 'SELECT c, v FROM t WHERE false' }));
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/no rows/i);
        expect(renderer.render).not.toHaveBeenCalled();
    });

    it('requires chart_type and x in its schema', () => {
        const tool = createRenderChartTool(stubRenderer(), null);
        expect(tool.inputSchema.required).toEqual(['chart_type', 'x']);
        expect(tool.inputSchema.properties.chart_type.enum).toEqual(['bar', 'line', 'scatter', 'histogram']);
    });
});

describe('create_slider', () => {
    const stubMapManager = () => ({
        createSlider: vi.fn((args) => ({ success: true, layer: args.layer_id, field: args.field, min: args.min, max: args.max, mode: args.mode === 'step' ? 'step' : 'cumulative' })),
        getLayerSummaries: () => [{ id: 'fires', displayName: 'Fires', type: 'vector' }],
    });
    const stubCatalog = { records: new Map() };

    const getTool = () => {
        const mapManager = stubMapManager();
        const tool = createMapTools(mapManager, stubCatalog).find(t => t.name === 'create_slider');
        return { tool, mapManager };
    };

    it('forwards args verbatim to mapManager.createSlider', async () => {
        const { tool, mapManager } = getTool();
        const args = { layer_id: 'fires', field: 'YEAR_', min: 1835, max: 2024, step: 1, mode: 'cumulative', animate: true };
        const result = JSON.parse(await tool.execute(args));
        expect(result.success).toBe(true);
        expect(mapManager.createSlider).toHaveBeenCalledWith(args);
    });

    it('requires layer_id, field, min, and max in its schema', () => {
        const { tool } = getTool();
        expect(tool.inputSchema.required).toEqual(['layer_id', 'field', 'min', 'max']);
    });

    it('constrains mode to cumulative | step', () => {
        const { tool } = getTool();
        expect(tool.inputSchema.properties.mode.enum).toEqual(['cumulative', 'step']);
    });
});

describe('geocode tool', () => {
    const stubMap = { getLayerSummaries: () => [] };
    const stubCatalog = { records: new Map() };
    const getTool = (geocoder) =>
        createMapTools(stubMap, stubCatalog, null, geocoder).find(t => t.name === 'geocode');

    it('is only registered when a geocoder is provided', () => {
        expect(getTool(undefined)).toBeUndefined();
        expect(getTool({ forwardGeocode: vi.fn() })).toBeDefined();
    });

    it('returns ranked candidates and the source on success', async () => {
        const results = [{ lat: 37.8, lon: -119.5, bbox: null, display_name: 'Yosemite', match_quality: 'high', source: 'nominatim' }];
        const forwardGeocode = vi.fn(async () => results);
        const out = JSON.parse(await getTool({ forwardGeocode }).execute({ query: 'Yosemite' }));
        expect(out).toMatchObject({ success: true, count: 1, source: 'nominatim', results });
        // default limit applied
        expect(forwardGeocode).toHaveBeenCalledWith('Yosemite', { limit: 5 });
    });

    it('passes a custom limit through', async () => {
        const forwardGeocode = vi.fn(async () => []);
        await getTool({ forwardGeocode }).execute({ query: 'x', limit: 3 });
        expect(forwardGeocode).toHaveBeenCalledWith('x', { limit: 3 });
    });

    it('returns a no-match message (success:true, count:0) when nothing is found', async () => {
        const out = JSON.parse(await getTool({ forwardGeocode: async () => [] }).execute({ query: 'asdfqwer' }));
        expect(out).toMatchObject({ success: true, count: 0, results: [] });
        expect(out.message).toMatch(/No location found/);
    });

    it('surfaces backend failures as success:false with the error message', async () => {
        const forwardGeocode = async () => { throw new Error('HTTP 429'); };
        const out = JSON.parse(await getTool({ forwardGeocode }).execute({ query: 'x' }));
        expect(out).toMatchObject({ success: false });
        expect(out.error).toMatch(/429/);
    });
});

describe('get_user_location tool', () => {
    const stubMap = { getLayerSummaries: () => [] };
    const stubCatalog = { records: new Map() };
    const getTool = (options) =>
        createMapTools(stubMap, stubCatalog, null, null, options).find(t => t.name === 'get_user_location');

    const origNavigator = globalThis.navigator;
    afterEach(() => {
        if (origNavigator === undefined) delete globalThis.navigator;
        else Object.defineProperty(globalThis, 'navigator', { value: origNavigator, configurable: true });
    });
    const setGeolocation = (geo) => {
        Object.defineProperty(globalThis, 'navigator', { value: { geolocation: geo }, configurable: true });
    };

    it('is only registered when geolocateTool is opted in', () => {
        expect(getTool({})).toBeUndefined();
        expect(getTool({ geolocateTool: false })).toBeUndefined();
        expect(getTool({ geolocateTool: true })).toBeDefined();
    });

    it('returns the coordinate on success', async () => {
        setGeolocation({
            getCurrentPosition: (ok) => ok({ coords: { latitude: 37.87, longitude: -122.27, accuracy: 12 } }),
        });
        const out = JSON.parse(await getTool({ geolocateTool: true }).execute({}));
        expect(out).toEqual({ success: true, latitude: 37.87, longitude: -122.27, accuracy_m: 12 });
    });

    it('reports a permission denial as success:false with a clear reason', async () => {
        setGeolocation({ getCurrentPosition: (_ok, err) => err({ code: 1, message: 'User denied Geolocation' }) });
        const out = JSON.parse(await getTool({ geolocateTool: true }).execute({}));
        expect(out.success).toBe(false);
        expect(out.error).toMatch(/denied/i);
    });

    it('reports gracefully when geolocation is unavailable', async () => {
        setGeolocation(undefined);
        const out = JSON.parse(await getTool({ geolocateTool: true }).execute({}));
        expect(out.success).toBe(false);
        expect(out.error).toMatch(/not available/i);
    });
});

describe('createMapTools smoke test', () => {
    const stubMapManager = {
        getLayerSummaries: () => [],
        setFilter: () => ({ success: true }),
    };
    const stubCatalog = { records: new Map() };

    it('returns expected tool names without mcpClient', () => {
        const tools = createMapTools(stubMapManager, stubCatalog);
        const names = tools.map(t => t.name).sort();
        expect(names).toEqual([
            'add_hex_tile_layer',
            'clear_filter',
            'create_slider',
            'fly_to',
            'get_map_state',
            'get_schema',
            'hide_layer',
            'list_datasets',
            'remove_hex_tile_layer',
            'reset_filter',
            'reset_style',
            'reset_tooltip',
            'set_filter',
            'set_projection',
            'set_style',
            'set_tooltip',
            'show_layer',
        ]);
    });

    it('adds filter_by_query when mcpClient is provided', () => {
        const tools = createMapTools(stubMapManager, stubCatalog, { callTool: () => null });
        const names = tools.map(t => t.name);
        expect(names).toContain('filter_by_query');
    });

    it('every tool has an execute function', () => {
        const tools = createMapTools(stubMapManager, stubCatalog, { callTool: () => null });
        for (const tool of tools) {
            expect(typeof tool.execute).toBe('function');
        }
    });

    // Regression guard for #243: an array-typed param with no `items` compiles,
    // under grammar-constrained tool decoding, to a grammar that can only emit
    // `[]` — which silently collapsed every set_filter call to an empty filter.
    // Every array param MUST declare `items` (even `{}`) so the grammar permits
    // content. This invariant catches the bug for set_filter and any future tool.
    it('every array-typed tool param declares items (constrained-decoding safety, #243)', () => {
        const tools = createMapTools(stubMapManager, stubCatalog, { callTool: () => null });
        for (const tool of tools) {
            const props = tool.inputSchema?.properties || {};
            for (const [name, schema] of Object.entries(props)) {
                if (schema.type === 'array') {
                    expect(schema.items, `${tool.name}.${name} must declare 'items'`).toBeDefined();
                }
            }
        }
    });

    it('set_filter.filter declares items so it is not grammar-collapsed to [] (#243)', () => {
        const tools = createMapTools(stubMapManager, stubCatalog);
        const setFilter = tools.find(t => t.name === 'set_filter');
        expect(setFilter.inputSchema.properties.filter.type).toBe('array');
        expect(setFilter.inputSchema.properties.filter.items).toBeDefined();
    });
});
