import { describe, it, expect, vi, afterEach } from 'vitest';
import { Agent } from '../app/agent.js';

// Guards the prompt-prefix-stability invariant documented in
// docs/design/prompt-prefix-stability.md (#273 suggestion 1): the cacheable
// prefix — the system message — must be byte-identical across turns and equal to
// the frozen systemPrompt. A regression that injects per-turn dynamic content
// (a date, map state, a session id) into the system prefix would break caching
// for the entire suffix; this test fails loudly if that happens.

const stubToolRegistry = {
    getToolsForLLM: () => [],
    isLocal: () => true,
    execute: async () => ({ result: '' }),
};

const makeAgent = () => new Agent(
    { llm_models: [{ value: 'm', endpoint: 'https://x/v1', api_key: 'k' }] },
    stubToolRegistry,
);

// Each LLM call returns a plain-text final answer (no tool_calls), so every
// processMessage() completes in a single turn.
const okResponse = (content = 'final answer') => ({
    ok: true,
    json: async () => ({ choices: [{ message: { role: 'assistant', content } }] }),
});

describe('prompt-prefix stability (#273)', () => {
    afterEach(() => vi.restoreAllMocks());

    it('sends a byte-identical system message across turns, equal to the frozen prompt', async () => {
        const SYSTEM = '# Analyst\n\nStable system prompt with an injected catalog.\n' + 'dataset paths. '.repeat(50);
        const agent = makeAgent();
        agent.setSystemPrompt(SYSTEM);

        const sent = [];
        global.fetch = vi.fn(async (_url, opts) => {
            sent.push(JSON.parse(opts.body));
            return okResponse();
        });

        await agent.processMessage('first question');
        await agent.processMessage('second question');

        expect(sent).toHaveLength(2);
        // System message is first, on both turns.
        expect(sent[0].messages[0].role).toBe('system');
        expect(sent[1].messages[0].role).toBe('system');
        // Byte-identical across turns …
        expect(sent[1].messages[0]).toEqual(sent[0].messages[0]);
        // … and equal to exactly what was frozen (no per-send mutation/injection).
        expect(sent[0].messages[0].content).toBe(SYSTEM);
        // The volatile user turn differs, confirming the suffix — not the prefix —
        // is what changes between requests.
        expect(sent[0].messages.at(-1).content).toBe('first question');
        expect(sent[1].messages.at(-1).content).toBe('second question');
    });

    it('does not mutate agent.systemPrompt while running a turn', async () => {
        const SYSTEM = 'frozen prompt';
        const agent = makeAgent();
        agent.setSystemPrompt(SYSTEM);
        global.fetch = vi.fn(async () => okResponse());

        await agent.processMessage('q');

        expect(agent.systemPrompt).toBe(SYSTEM);
    });
});
