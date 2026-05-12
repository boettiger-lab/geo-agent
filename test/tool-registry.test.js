import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolRegistry } from '../app/tool-registry.js';

const stubMcpTool = (name = 'get_stac_details') => ({
    name,
    description: 'stub',
    inputSchema: { type: 'object', properties: {}, required: [] },
});

describe('ToolRegistry argsRewriter', () => {
    it('forwards original args when no rewriter is registered', async () => {
        const callTool = vi.fn(async () => 'ok');
        const reg = new ToolRegistry();
        reg.registerRemote([stubMcpTool()], { callTool });

        await reg.execute('get_stac_details', { dataset_id: 'foo' });

        expect(callTool).toHaveBeenCalledWith('get_stac_details', { dataset_id: 'foo' });
    });

    it('passes (toolName, args) to the rewriter and forwards its return value', async () => {
        const callTool = vi.fn(async () => 'ok');
        const rewriter = vi.fn((name, args) => ({ ...args, collection: { id: args.dataset_id } }));
        const reg = new ToolRegistry();
        reg.registerRemote([stubMcpTool()], { callTool }, rewriter);

        await reg.execute('get_stac_details', { dataset_id: 'foo' });

        expect(rewriter).toHaveBeenCalledWith('get_stac_details', { dataset_id: 'foo' });
        expect(callTool).toHaveBeenCalledWith('get_stac_details', {
            dataset_id: 'foo',
            collection: { id: 'foo' },
        });
    });

    it('rewriter return value of original args (no-op) leaves the call untouched', async () => {
        const callTool = vi.fn(async () => 'ok');
        const rewriter = vi.fn((name, args) => args);
        const reg = new ToolRegistry();
        reg.registerRemote([stubMcpTool()], { callTool }, rewriter);

        await reg.execute('get_stac_details', { dataset_id: 'foo', catalog_url: 'https://other' });

        expect(callTool).toHaveBeenCalledWith('get_stac_details', {
            dataset_id: 'foo',
            catalog_url: 'https://other',
        });
    });

    it('does not invoke the rewriter for local tools', async () => {
        const rewriter = vi.fn((name, args) => args);
        const reg = new ToolRegistry();
        reg.registerLocal({
            name: 'local_tool',
            description: 'local',
            inputSchema: { type: 'object', properties: {} },
            execute: async () => 'done',
        });
        reg.registerRemote([stubMcpTool()], { callTool: vi.fn() }, rewriter);

        await reg.execute('local_tool', { x: 1 });

        expect(rewriter).not.toHaveBeenCalled();
    });
});

describe('ToolRegistry cleanSchema', () => {
    const reg = new ToolRegistry();

    it('returns a minimal object schema for null/undefined input', () => {
        expect(reg.cleanSchema(null)).toEqual({ type: 'object', properties: {}, required: [] });
        expect(reg.cleanSchema(undefined)).toEqual({ type: 'object', properties: {}, required: [] });
    });

    it('preserves type/properties/required when present', () => {
        const out = reg.cleanSchema({
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
        });
        expect(out).toEqual({
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
        });
    });

    it('fills in missing type and properties', () => {
        const out = reg.cleanSchema({});
        expect(out.type).toBe('object');
        expect(out.properties).toEqual({});
    });

    it('collapses anyOf to the first concrete (non-null) type, preserving description', () => {
        const out = reg.cleanSchema({
            type: 'object',
            properties: {
                x: { anyOf: [{ type: 'null' }, { type: 'string' }], description: 'maybe' },
            },
        });
        expect(out.properties.x.type).toBe('string');
        expect(out.properties.x.description).toBe('maybe');
        expect(out.properties.x.anyOf).toBeUndefined();
    });

    it('falls back to object when anyOf has no concrete type', () => {
        const out = reg.cleanSchema({
            properties: { y: { anyOf: [{ type: 'null' }] } },
        });
        expect(out.properties.y.type).toBe('object');
    });

    it('does not mutate the input schema', () => {
        const input = {
            properties: { x: { anyOf: [{ type: 'string' }] } },
        };
        const before = JSON.stringify(input);
        reg.cleanSchema(input);
        expect(JSON.stringify(input)).toBe(before);
    });
});

describe('ToolRegistry queries and dispatch', () => {
    let reg;
    beforeEach(() => {
        reg = new ToolRegistry();
        reg.registerLocal({
            name: 'local_x',
            description: 'L',
            inputSchema: { type: 'object', properties: {} },
            execute: () => 'L-out',
        });
        reg.registerRemote([{ name: 'remote_y', description: 'R', inputSchema: { type: 'object', properties: {} } }], {
            callTool: async () => 'R-out',
        });
    });

    it('isLocal distinguishes local from remote tools', () => {
        expect(reg.isLocal('local_x')).toBe(true);
        expect(reg.isLocal('remote_y')).toBe(false);
        expect(reg.isLocal('absent')).toBe(false);
    });

    it('has reflects registry membership', () => {
        expect(reg.has('local_x')).toBe(true);
        expect(reg.has('remote_y')).toBe(true);
        expect(reg.has('absent')).toBe(false);
    });

    it('getNames returns all registered names', () => {
        expect(reg.getNames().sort()).toEqual(['local_x', 'remote_y']);
    });

    it('getToolsForLLM emits OpenAI function-calling shape', () => {
        const tools = reg.getToolsForLLM();
        expect(tools).toHaveLength(2);
        for (const t of tools) {
            expect(t.type).toBe('function');
            expect(t.function.name).toMatch(/^(local_x|remote_y)$/);
            expect(t.function.parameters.type).toBe('object');
        }
    });
});

describe('ToolRegistry execute error paths', () => {
    it('returns "Unknown tool" result on missing name', async () => {
        const reg = new ToolRegistry();
        const r = await reg.execute('nope', {});
        expect(r.success).toBe(false);
        expect(r.source).toBe('error');
        expect(r.result).toContain('Unknown tool: nope');
    });

    it('catches local tool errors and returns a structured failure', async () => {
        const reg = new ToolRegistry();
        reg.registerLocal({
            name: 'boom',
            description: 'b',
            inputSchema: { type: 'object', properties: {} },
            execute: () => { throw new Error('local boom'); },
        });
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const r = await reg.execute('boom', {});
        expect(r.success).toBe(false);
        expect(r.source).toBe('error');
        expect(r.result).toContain('local boom');
        errSpy.mockRestore();
    });

    it('catches remote tool errors and returns a structured failure', async () => {
        const reg = new ToolRegistry();
        reg.registerRemote([{ name: 'remote_boom', description: 'r', inputSchema: { type: 'object', properties: {} } }], {
            callTool: async () => { throw new Error('mcp boom'); },
        });
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const r = await reg.execute('remote_boom', {});
        expect(r.success).toBe(false);
        expect(r.source).toBe('error');
        expect(r.result).toContain('mcp boom');
        errSpy.mockRestore();
    });

    it('JSON-stringifies non-string local results', async () => {
        const reg = new ToolRegistry();
        reg.registerLocal({
            name: 'obj',
            description: 'o',
            inputSchema: { type: 'object', properties: {} },
            execute: () => ({ x: 1 }),
        });
        const r = await reg.execute('obj', {});
        expect(r.success).toBe(true);
        expect(r.result).toBe('{"x":1}');
    });

    it('captures sql_query on remote tool result for chat-ui display', async () => {
        const reg = new ToolRegistry();
        reg.registerRemote([{ name: 'query', description: 'q', inputSchema: { type: 'object', properties: {} } }], {
            callTool: async () => 'rows',
        });
        const r = await reg.execute('query', { sql_query: 'SELECT 1' });
        expect(r.sqlQuery).toBe('SELECT 1');
    });
});

describe('ToolRegistry executeAll', () => {
    it('runs calls sequentially and collects results', async () => {
        const reg = new ToolRegistry();
        const order = [];
        reg.registerLocal({
            name: 't1',
            description: '', inputSchema: { type: 'object', properties: {} },
            execute: async () => { order.push('t1'); return 'one'; },
        });
        reg.registerLocal({
            name: 't2',
            description: '', inputSchema: { type: 'object', properties: {} },
            execute: async () => { order.push('t2'); return 'two'; },
        });
        const results = await reg.executeAll([{ name: 't1', args: {} }, { name: 't2', args: {} }]);
        expect(order).toEqual(['t1', 't2']);
        expect(results.map(r => r.result)).toEqual(['one', 'two']);
    });
});

describe('ToolRegistry clearRemote', () => {
    it('drops only remote tools and leaves local tools intact', () => {
        const reg = new ToolRegistry();
        reg.registerLocal({
            name: 'local_a',
            description: '', inputSchema: { type: 'object', properties: {} },
            execute: () => 'ok',
        });
        reg.registerRemote([
            { name: 'remote_a', description: '', inputSchema: { type: 'object', properties: {} } },
            { name: 'remote_b', description: '', inputSchema: { type: 'object', properties: {} } },
        ], { callTool: vi.fn() });

        expect(reg.getNames().sort()).toEqual(['local_a', 'remote_a', 'remote_b']);
        reg.clearRemote();
        expect(reg.getNames()).toEqual(['local_a']);
    });

    it('is a no-op when no remote tools are registered', () => {
        const reg = new ToolRegistry();
        reg.registerLocal({
            name: 'l',
            description: '', inputSchema: { type: 'object', properties: {} },
            execute: () => 'ok',
        });
        reg.clearRemote();
        expect(reg.getNames()).toEqual(['l']);
    });

    it('lets a subsequent registerRemote install a fresh tool set', () => {
        const reg = new ToolRegistry();
        reg.registerRemote([{ name: 'old_only', description: '', inputSchema: { type: 'object', properties: {} } }], { callTool: vi.fn() });
        reg.clearRemote();
        reg.registerRemote([
            { name: 'new_a', description: '', inputSchema: { type: 'object', properties: {} } },
            { name: 'new_b', description: '', inputSchema: { type: 'object', properties: {} } },
        ], { callTool: vi.fn() });
        expect(reg.getNames().sort()).toEqual(['new_a', 'new_b']);
    });
});

describe('ToolRegistry registerLocal duplicate handling', () => {
    it('warns on overwrite but accepts the new tool', () => {
        const reg = new ToolRegistry();
        const tool = (out) => ({
            name: 'dup', description: '', inputSchema: { type: 'object', properties: {} },
            execute: () => out,
        });
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        reg.registerLocal(tool('first'));
        reg.registerLocal(tool('second'));
        expect(warnSpy).toHaveBeenCalledWith('[Tools] Overwriting tool: dup');
        warnSpy.mockRestore();
    });
});
