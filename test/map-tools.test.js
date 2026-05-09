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
