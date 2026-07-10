import { describe, it, expect, vi, afterEach } from 'vitest';
import { Agent } from '../app/agent.js';

const stubToolRegistry = {
    getToolsForLLM: () => [],
    isLocal: () => true,
    execute: async () => ({ result: '' }),
};

const makeAgent = (config = {}) => new Agent(
    { llm_models: [{ value: 'm', endpoint: 'https://x/v1', api_key: 'k' }], ...config },
    stubToolRegistry,
);

const okResponse = () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
});

/** Capture the JSON body of the single fetch a callLLM makes. */
const captureCall = async (agent, modelConfig, messages) => {
    let body;
    global.fetch = vi.fn(async (_url, opts) => {
        body = JSON.parse(opts.body);
        return okResponse();
    });
    await agent.callLLM('https://x/chat/completions', { api_key: 'k', ...modelConfig }, messages, []);
    return body;
};

const sys = (text = 'SYSTEM PROMPT') => ({ role: 'system', content: text });
const user = (text = 'hi') => ({ role: 'user', content: text });

describe('Agent prompt caching (#273)', () => {
    afterEach(() => vi.restoreAllMocks());

    it('default (no flag): system message stays a plain string — byte-identical to today', async () => {
        const agent = makeAgent();
        const body = await captureCall(agent, {}, [sys(), user()]);
        expect(body.messages[0].content).toBe('SYSTEM PROMPT');
        expect(JSON.stringify(body)).not.toContain('cache_control');
    });

    it('per-model prompt_cache:true adds a cache_control breakpoint on the system prompt', async () => {
        const agent = makeAgent();
        const body = await captureCall(agent, { prompt_cache: true }, [sys('BIG PREFIX'), user()]);
        expect(body.messages[0]).toEqual({
            role: 'system',
            content: [{ type: 'text', text: 'BIG PREFIX', cache_control: { type: 'ephemeral' } }],
        });
    });

    it('global prompt_cache:true is honored', async () => {
        const agent = makeAgent({ prompt_cache: true });
        const body = await captureCall(agent, {}, [sys(), user()]);
        expect(body.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('per-model prompt_cache:false overrides a global true', async () => {
        const agent = makeAgent({ prompt_cache: true });
        const body = await captureCall(agent, { prompt_cache: false }, [sys(), user()]);
        expect(body.messages[0].content).toBe('SYSTEM PROMPT');
        expect(JSON.stringify(body)).not.toContain('cache_control');
    });

    it('leaves non-system messages untouched when enabled', async () => {
        const agent = makeAgent();
        const body = await captureCall(agent, { prompt_cache: true }, [sys(), user('question')]);
        expect(body.messages[1]).toEqual({ role: 'user', content: 'question' });
    });

    it('does not mutate the caller\'s messages array', async () => {
        const agent = makeAgent();
        const messages = [sys(), user()];
        await captureCall(agent, { prompt_cache: true }, messages);
        expect(messages[0].content).toBe('SYSTEM PROMPT'); // still a plain string
    });

    it('handles a prompt with no system message without crashing', async () => {
        const agent = makeAgent();
        const body = await captureCall(agent, { prompt_cache: true }, [user('just a user turn')]);
        expect(body.messages).toEqual([{ role: 'user', content: 'just a user turn' }]);
    });
});
