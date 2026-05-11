import { describe, it, expect, vi } from 'vitest';
import { extractJsonArray, createMapTools } from '../app/map-tools.js';

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
            'clear_filter',
            'fly_to',
            'get_map_state',
            'get_schema',
            'hide_layer',
            'list_datasets',
            'reset_filter',
            'reset_style',
            'set_filter',
            'set_projection',
            'set_style',
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
});
