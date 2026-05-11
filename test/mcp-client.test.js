import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const clientInstances = [];

const buildClientInstance = () => ({
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    listTools: vi.fn(async () => ({ tools: [{ name: 'query' }] })),
    callTool: vi.fn(async () => ({ content: [{ text: 'ok' }] })),
    readResource: vi.fn(async () => ({ contents: [{ text: 'res-text' }] })),
    listResources: vi.fn(async () => ({ resources: [{ uri: 'r1' }] })),
    listPrompts: vi.fn(async () => ({ prompts: [{ name: 'p1' }] })),
    getPrompt: vi.fn(async () => ({ messages: [{ content: { text: 'hi' } }, { content: { text: 'there' } }] })),
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
    StreamableHTTPClientTransport: vi.fn(),
}));

const { MCPClient } = await import('../app/mcp-client.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');

const lastClient = () => clientInstances[clientInstances.length - 1];

// Quiet stdout — `[MCP] ...` console.log spam from each connect makes scrolling logs painful.
let consoleSpies;

beforeEach(() => {
    clientInstances.length = 0;
    Client.mockReset();
    Client.mockImplementation(() => {
        const instance = buildClientInstance();
        clientInstances.push(instance);
        return instance;
    });
    consoleSpies = [
        vi.spyOn(console, 'log').mockImplementation(() => {}),
        vi.spyOn(console, 'warn').mockImplementation(() => {}),
        vi.spyOn(console, 'error').mockImplementation(() => {}),
    ];
});
afterEach(() => {
    consoleSpies.forEach(s => s.mockRestore());
});

describe('MCPClient connect', () => {
    it('connects, caches tools, and is idempotent', async () => {
        const c = new MCPClient('https://mcp.example/mcp');
        await c.connect();
        expect(c.isConnected).toBe(true);
        expect(c.getTools()).toEqual([{ name: 'query' }]);

        const before = clientInstances.length;
        await c.connect();
        expect(clientInstances.length).toBe(before);
    });

    it('deduplicates parallel connect calls', async () => {
        const c = new MCPClient('https://mcp.example/mcp');
        await Promise.all([c.connect(), c.connect(), c.connect()]);
        expect(clientInstances.length).toBe(1);
    });

    it('on connect failure, marks disconnected and rethrows', async () => {
        Client.mockImplementationOnce(() => {
            const instance = buildClientInstance();
            instance.connect = vi.fn().mockRejectedValueOnce(new Error('boom'));
            clientInstances.push(instance);
            return instance;
        });
        const c = new MCPClient('https://mcp.example/mcp');
        await expect(c.connect()).rejects.toThrow('boom');
        expect(c.isConnected).toBe(false);
        expect(c.client).toBeNull();
    });
});

describe('MCPClient ensureConnected and reconnect', () => {
    it('listTools health check passes when connection is alive — no reconnect', async () => {
        const c = new MCPClient('https://mcp/');
        await c.connect();
        const before = clientInstances.length;
        await c.ensureConnected();
        expect(clientInstances.length).toBe(before);
    });

    it('on stale connection (listTools throws), reconnects', async () => {
        vi.useFakeTimers();
        try {
            const c = new MCPClient('https://mcp/');
            await c.connect();
            lastClient().listTools.mockRejectedValueOnce(new Error('stale'));

            const promise = c.ensureConnected();
            await vi.advanceTimersByTimeAsync(1000);
            await promise;

            expect(clientInstances.length).toBe(2);
            expect(c.isConnected).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('throws after maxReconnectAttempts', async () => {
        const c = new MCPClient('https://mcp/');
        c.reconnectAttempts = c.maxReconnectAttempts;
        await expect(c.reconnect()).rejects.toThrow(/unreachable after multiple attempts/i);
    });
});

describe('MCPClient callTool', () => {
    it('returns the text content of the first content part', async () => {
        const c = new MCPClient('https://mcp/');
        await c.connect();
        const out = await c.callTool('query', { sql_query: 'SELECT 1' });
        expect(out).toBe('ok');
    });

    it('returns a placeholder string when content text is empty/whitespace', async () => {
        const c = new MCPClient('https://mcp/');
        await c.connect();
        lastClient().callTool.mockResolvedValueOnce({ content: [{ text: '   ' }] });
        const out = await c.callTool('query', { sql_query: 'X' });
        expect(out).toMatch(/no data/i);
    });

    it('throws when result has no content', async () => {
        const c = new MCPClient('https://mcp/');
        await c.connect();
        lastClient().callTool.mockResolvedValueOnce({ content: [] });
        await expect(c.callTool('q', {})).rejects.toThrow(/no content/i);
    });

    it('retries once on a network/fetch error and returns the retry result', async () => {
        vi.useFakeTimers();
        try {
            const c = new MCPClient('https://mcp/');
            await c.connect();
            // First call on the original client throws a connection error.
            // The retry path sets connected=false → ensureConnected → reconnect
            // → builds a fresh Client, whose callTool returns 'after-retry'.
            lastClient().callTool.mockRejectedValueOnce(new TypeError('fetch failed'));
            Client.mockImplementationOnce(() => {
                const instance = buildClientInstance();
                instance.callTool = vi.fn(async () => ({ content: [{ text: 'after-retry' }] }));
                clientInstances.push(instance);
                return instance;
            });

            const promise = c.callTool('q', {});
            await vi.advanceTimersByTimeAsync(2000);  // backoff delay
            const out = await promise;
            expect(out).toBe('after-retry');
        } finally {
            vi.useRealTimers();
        }
    });

    it('rethrows non-connection errors without retry', async () => {
        const c = new MCPClient('https://mcp/');
        await c.connect();
        lastClient().callTool.mockRejectedValueOnce(new Error('SQL parse error'));
        await expect(c.callTool('q', {})).rejects.toThrow('SQL parse error');
    });
});

describe('MCPClient resources and prompts', () => {
    it('readResource returns the first content text, empty string if absent', async () => {
        const c = new MCPClient('https://mcp/');
        await c.connect();
        expect(await c.readResource('catalog://list')).toBe('res-text');

        lastClient().readResource.mockResolvedValueOnce({ contents: [] });
        expect(await c.readResource('catalog://empty')).toBe('');
    });

    it('listResources returns the resources array', async () => {
        const c = new MCPClient('https://mcp/');
        await c.connect();
        expect(await c.listResources()).toEqual([{ uri: 'r1' }]);
    });

    it('listPrompts returns the prompts array', async () => {
        const c = new MCPClient('https://mcp/');
        await c.connect();
        expect(await c.listPrompts()).toEqual([{ name: 'p1' }]);
    });

    it('getPrompt joins all message texts with two newlines', async () => {
        const c = new MCPClient('https://mcp/');
        await c.connect();
        expect(await c.getPrompt('analyst')).toBe('hi\n\nthere');
    });
});

describe('MCPClient disconnect and listTools refresh', () => {
    it('disconnect closes the SDK client and clears state', async () => {
        const c = new MCPClient('https://mcp/');
        await c.connect();
        const cl = lastClient();
        await c.disconnect();
        expect(cl.close).toHaveBeenCalled();
        expect(c.isConnected).toBe(false);
        expect(c.client).toBeNull();
    });

    it('listTools() refreshes the in-memory cache', async () => {
        const c = new MCPClient('https://mcp/');
        await c.connect();
        // ensureConnected() consumes one listTools call as its health check;
        // the second is the actual refresh, so override the default impl.
        lastClient().listTools.mockResolvedValue({ tools: [{ name: 'fresh1' }, { name: 'fresh2' }] });
        const out = await c.listTools();
        expect(out.map(t => t.name)).toEqual(['fresh1', 'fresh2']);
        expect(c.getTools().map(t => t.name)).toEqual(['fresh1', 'fresh2']);
    });
});
