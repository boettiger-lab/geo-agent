import { describe, it, expect, vi, afterEach } from 'vitest';
import { Agent } from '../app/agent.js';

const stubToolRegistry = { getToolsForLLM: () => [], isLocal: () => true, execute: async () => ({ result: '' }) };
const makeAgent = (config = {}) => new Agent(
    { llm_models: [{ value: 'm', endpoint: 'https://x/v1', api_key: 'k' }], ...config },
    stubToolRegistry,
);
const okResponse = () => ({ ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }) });

// Capture the headers of the single fetch a callLLM makes against `endpoint`.
const headersFor = async (agent, endpoint) => {
    let headers;
    global.fetch = vi.fn(async (_url, opts) => { headers = opts.headers; return okResponse(); });
    await agent.callLLM(endpoint, { api_key: 'k' }, [{ role: 'user', content: 'hi' }], []);
    return headers;
};

describe('X-Client attribution header, gated to trusted proxy hosts (#254)', () => {
    afterEach(() => vi.restoreAllMocks());

    it('sends X-Client to our proxy host', async () => {
        const h = await headersFor(makeAgent(), 'https://open-llm-proxy.nrp-nautilus.io/v1/chat/completions');
        expect(h['X-Client']).toMatch(/^geo-agent\//); // geo-agent/dev in tests (no @ref in a file:// URL)
    });

    it('does NOT send X-Client to a bring-your-own external endpoint', async () => {
        const h = await headersFor(makeAgent(), 'https://openrouter.ai/api/v1/chat/completions');
        expect(h['X-Client']).toBeUndefined();
        // Auth/content-type are unaffected.
        expect(h['Content-Type']).toBe('application/json');
        expect(h['Authorization']).toBe('Bearer k');
    });

    it('_isTrustedProxyHost matches the infra suffix (incl. bare apex) and rejects others', () => {
        const a = makeAgent();
        expect(a._isTrustedProxyHost('https://open-llm-proxy.nrp-nautilus.io/v1')).toBe(true);
        expect(a._isTrustedProxyHost('https://nrp-nautilus.io/v1')).toBe(true);
        expect(a._isTrustedProxyHost('https://openrouter.ai/api/v1')).toBe(false);
        expect(a._isTrustedProxyHost('https://evil-nrp-nautilus.io/v1')).toBe(false); // suffix, not substring
        expect(a._isTrustedProxyHost('not a url')).toBe(false);
    });

    it('honors a per-deployment client_header_hosts override', async () => {
        const agent = makeAgent({ client_header_hosts: ['myproxy.example.com'] });
        expect((await headersFor(agent, 'https://myproxy.example.com/v1/chat/completions'))['X-Client']).toMatch(/^geo-agent\//);
        // Default infra host no longer trusted once overridden.
        expect((await headersFor(agent, 'https://open-llm-proxy.nrp-nautilus.io/v1/chat/completions'))['X-Client']).toBeUndefined();
    });
});
