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
