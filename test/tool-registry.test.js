import { describe, it, expect, vi } from 'vitest';
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
