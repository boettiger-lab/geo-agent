import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent } from '../app/agent.js';

const stubToolRegistry = {
    getToolsForLLM: () => [],
    isLocal: () => true,
    execute: async () => ({ result: '' }),
    has: () => false,
};

const makeAgent = () => {
    const agent = new Agent(
        { llm_models: [{ value: 'm', endpoint: 'https://x/v1', api_key: 'k' }] },
        stubToolRegistry,
    );
    return agent;
};

const okResponse = (message) => ({
    ok: true,
    json: async () => ({ choices: [{ message }] }),
});

describe('Agent reasoning extraction', () => {
    let originalFetch;

    beforeEach(() => {
        originalFetch = global.fetch;
    });

    afterEach(() => {
        global.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    it('emits onReasoning when reasoning_content is present on the message', async () => {
        const agent = makeAgent();
        const events = [];
        agent.onReasoning = (text, iter) => events.push({ text, iter });

        global.fetch = vi.fn().mockResolvedValueOnce(okResponse({
            role: 'assistant',
            content: 'Here you go.',
            reasoning_content: 'I considered options A and B and chose B.',
        }));

        await agent.processMessage('hi');

        expect(events).toHaveLength(1);
        expect(events[0].text).toBe('I considered options A and B and chose B.');
    });

    it('emits onReasoning for inline <think> blocks and strips them from displayed content', async () => {
        const agent = makeAgent();
        const events = [];
        agent.onReasoning = (text) => events.push(text);

        global.fetch = vi.fn().mockResolvedValueOnce(okResponse({
            role: 'assistant',
            content: '<think>step 1\nstep 2</think>\nFinal answer here.',
        }));

        const { response } = await agent.processMessage('hi');

        expect(events).toHaveLength(1);
        expect(events[0]).toContain('step 1');
        expect(events[0]).toContain('step 2');
        // The displayed response should not contain the <think> block
        expect(response).not.toContain('<think>');
        expect(response).toContain('Final answer here.');
    });

    it('handles multiple <think> blocks in one message', async () => {
        const agent = makeAgent();
        const events = [];
        agent.onReasoning = (text) => events.push(text);

        global.fetch = vi.fn().mockResolvedValueOnce(okResponse({
            role: 'assistant',
            content: '<think>first</think>middle<think>second</think>end',
        }));

        const { response } = await agent.processMessage('hi');

        // Both think blocks captured (joined)
        expect(events).toHaveLength(1);
        expect(events[0]).toContain('first');
        expect(events[0]).toContain('second');
        // Visible content has both blocks stripped
        expect(response).not.toContain('<think>');
        expect(response).toContain('middle');
        expect(response).toContain('end');
    });

    it('does not emit onReasoning when neither reasoning_content nor <think> is present', async () => {
        const agent = makeAgent();
        const events = [];
        agent.onReasoning = (text) => events.push(text);

        global.fetch = vi.fn().mockResolvedValueOnce(okResponse({
            role: 'assistant',
            content: 'Plain answer.',
        }));

        await agent.processMessage('hi');

        expect(events).toHaveLength(0);
    });

    it('strips reasoning_content from the assistant message stored in history', async () => {
        const agent = makeAgent();
        agent.onReasoning = () => {};

        global.fetch = vi.fn().mockResolvedValueOnce(okResponse({
            role: 'assistant',
            content: 'Answer.',
            reasoning_content: 'Big chain of thought that should not be re-sent.',
        }));

        await agent.processMessage('hi');

        const lastAssistant = agent.messages.at(-1);
        expect(lastAssistant.role).toBe('assistant');
        expect(lastAssistant.reasoning_content).toBeUndefined();
        expect(lastAssistant.content).toBe('Answer.');
    });
});

// Build an agent whose config carries the given per-model + top-level keys.
const makeConfiguredAgent = (modelExtra = {}, topLevel = {}) => new Agent(
    {
        llm_models: [{ value: 'm', endpoint: 'https://x/v1', api_key: 'k', ...modelExtra }],
        ...topLevel,
    },
    stubToolRegistry,
);

describe('Agent reasoning-toggle resolution (#283)', () => {
    it('_reasoningCapable is false by default (opt-in)', () => {
        const a = makeConfiguredAgent();
        expect(a._reasoningCapable(a.getModelConfig())).toBe(false);
    });

    it('_reasoningCapable reads per-model, then top-level, per-model wins', () => {
        const perModel = makeConfiguredAgent({ reasoning_toggle: true });
        expect(perModel._reasoningCapable(perModel.getModelConfig())).toBe(true);

        const global = makeConfiguredAgent({}, { reasoning_toggle: true });
        expect(global._reasoningCapable(global.getModelConfig())).toBe(true);

        const perModelOff = makeConfiguredAgent({ reasoning_toggle: false }, { reasoning_toggle: true });
        expect(perModelOff._reasoningCapable(perModelOff.getModelConfig())).toBe(false);
    });

    it('_reasoningDefault returns a boolean when set, else undefined', () => {
        const none = makeConfiguredAgent();
        expect(none._reasoningDefault(none.getModelConfig())).toBeUndefined();

        const off = makeConfiguredAgent({ reasoning_default: false });
        expect(off._reasoningDefault(off.getModelConfig())).toBe(false);

        const globalOn = makeConfiguredAgent({}, { reasoning_default: true });
        expect(globalOn._reasoningDefault(globalOn.getModelConfig())).toBe(true);
    });

    it('_thinkingParams emits nothing when the model does not participate', () => {
        const a = makeConfiguredAgent();
        expect(a._thinkingParams(a.getModelConfig())).toEqual({});
    });

    it('_thinkingParams emits a configured default even without a toggle', () => {
        const a = makeConfiguredAgent({ reasoning_default: false });
        expect(a._thinkingParams(a.getModelConfig())).toEqual({ enable_thinking: false });
    });

    it('_thinkingParams: toggle-capable but no default and no override → omit', () => {
        const a = makeConfiguredAgent({ reasoning_toggle: true });
        expect(a._thinkingParams(a.getModelConfig())).toEqual({});
    });

    it('_thinkingParams: user override wins over the configured default', () => {
        const a = makeConfiguredAgent({ reasoning_toggle: true, reasoning_default: true });
        a.reasoningOverride = false;
        expect(a._thinkingParams(a.getModelConfig())).toEqual({ enable_thinking: false });
    });

    it('setModel clears the reasoning override', () => {
        const a = makeConfiguredAgent({ reasoning_toggle: true });
        a.reasoningOverride = false;
        a.setModel('m');
        expect(a.reasoningOverride).toBeNull();
    });
});

describe('Agent.callLLM enable_thinking in payload (#283)', () => {
    let originalFetch;
    beforeEach(() => { originalFetch = global.fetch; });
    afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

    const captureBodies = () => {
        const bodies = [];
        global.fetch = vi.fn(async (url, opts) => {
            bodies.push(JSON.parse(opts.body));
            return okResponse({ role: 'assistant', content: 'ok' });
        });
        return bodies;
    };

    it('omits enable_thinking for a non-participating model', async () => {
        const a = makeConfiguredAgent();
        const bodies = captureBodies();
        await a.callLLM('https://x/v1', a.getModelConfig(), [], []);
        expect('enable_thinking' in bodies[0]).toBe(false);
    });

    it('sends enable_thinking:false when the user turns reasoning off', async () => {
        const a = makeConfiguredAgent({ reasoning_toggle: true, reasoning_default: true });
        a.reasoningOverride = false;
        const bodies = captureBodies();
        await a.callLLM('https://x/v1', a.getModelConfig(), [], []);
        expect(bodies[0].enable_thinking).toBe(false);
    });
});
