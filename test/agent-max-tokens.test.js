import { describe, it, expect, vi, afterEach } from 'vitest';
import { Agent } from '../app/agent.js';

/**
 * #387 — an optional `max_tokens`, and what happens when a response stops at
 * the output limit (`finish_reason: "length"`), whether that limit was ours or
 * the model's own ceiling. The second matters with no config at all: models
 * have run 30+ minutes to a 131k ceiling, one emitting 18,579 identical tool
 * calls (open-llm-proxy#150).
 */

const stubRegistry = (overrides = {}) => ({
    getToolsForLLM: () => [],
    isLocal: () => true,
    has: () => true,
    execute: vi.fn(async (name) => ({ success: true, name, result: 'ok', source: 'local' })),
    ...overrides,
});

const agentWith = (config = {}, model = {}, registry = stubRegistry()) => new Agent({
    llm_models: [{ value: 'm', endpoint: 'https://x/v1', api_key: 'k', ...model }],
    ...config,
}, registry);

/** A fetch response carrying one choice with the given finish_reason (and optional extras). */
const reply = (message, finish_reason, extra = {}) => ({
    ok: true,
    json: async () => ({
        choices: [{ message: { role: 'assistant', ...message }, finish_reason, ...(extra.choice || {}) }],
        ...(extra.usage ? { usage: extra.usage } : {}),
    }),
});

const sentPayload = (call = 0) => JSON.parse(global.fetch.mock.calls[call][1].body);

afterEach(() => { vi.restoreAllMocks(); });

describe('max_tokens resolution (_samplingParams)', () => {
    it('is omitted when nothing sets it — unset stays unset', () => {
        expect(agentWith()._samplingParams({})).toEqual({ temperature: 0 });
    });

    it('reads per-model first, then the global default', () => {
        const a = agentWith({ max_tokens: 4096 });
        expect(a._samplingParams({})).toMatchObject({ max_tokens: 4096 });
        expect(a._samplingParams({ max_tokens: 8192 })).toMatchObject({ max_tokens: 8192 });
    });

    it('lets a model opt out of a global cap with null', () => {
        expect(agentWith({ max_tokens: 4096 })._samplingParams({ max_tokens: null })).not.toHaveProperty('max_tokens');
    });

    it('coerces a numeric string, as a generated config.json can carry it', () => {
        expect(agentWith()._samplingParams({ max_tokens: '8192' })).toMatchObject({ max_tokens: 8192 });
    });

    it('drops anything but a positive integer, with a warning', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        for (const bad of [0, -5, 1.5, 'lots', true, {}]) {
            expect(agentWith()._samplingParams({ max_tokens: bad }), String(bad)).not.toHaveProperty('max_tokens');
        }
        expect(warn).toHaveBeenCalled();
    });

    it('reaches the request payload', async () => {
        global.fetch = vi.fn().mockResolvedValueOnce(reply({ content: 'Hi.' }, 'stop'));
        await agentWith({}, { max_tokens: 2048 }).processMessage('q');
        expect(sentPayload().max_tokens).toBe(2048);
    });

    it('is absent from the payload when unset', async () => {
        global.fetch = vi.fn().mockResolvedValueOnce(reply({ content: 'Hi.' }, 'stop'));
        await agentWith().processMessage('q');
        expect(sentPayload()).not.toHaveProperty('max_tokens');
    });
});

describe('a response that stops at the output limit', () => {
    it('does not record finish_reason on the message itself (it goes back upstream as history)', async () => {
        global.fetch = vi.fn()
            .mockResolvedValueOnce(reply({ content: null, tool_calls: [
                { id: 'c1', type: 'function', function: { name: 'show_layer', arguments: '{}' } }] }, 'tool_calls'))
            .mockResolvedValueOnce(reply({ content: 'Done.' }, 'stop'));
        await agentWith().processMessage('q');
        const history = sentPayload(1).messages;
        expect(history.some(m => 'finish_reason' in m)).toBe(false);
    });

    it('shows a cut-off text answer, marked as cut off, naming the configured limit', async () => {
        global.fetch = vi.fn().mockResolvedValueOnce(reply({ content: 'The total is 26,471,459 acres, and by' }, 'length'));
        const a = agentWith({}, { max_tokens: 512 });
        const res = await a.processMessage('q');
        expect(res.truncated).toBe(true);
        expect(res.response).toMatch(/^The total is 26,471,459 acres, and by/);
        expect(res.response).toContain('cut off at the response limit (max_tokens: 512)');
        expect(res.response).toContain('Raise max_tokens');
    });

    it("names the model's own ceiling when no max_tokens is set", async () => {
        global.fetch = vi.fn().mockResolvedValueOnce(reply({ content: 'A long answer that' }, 'length'));
        const res = await agentWith().processMessage('q');
        expect(res.response).toContain("cut off at the model's maximum response length");
        expect(res.response).not.toContain('Raise max_tokens');
    });

    it('runs none of the tool calls in a runaway response (the 18,579-call case)', async () => {
        const execute = vi.fn();
        const calls = Array.from({ length: 500 }, (_, i) =>
            ({ id: `c${i}`, type: 'function', function: { name: 'query', arguments: '{}' } }));
        global.fetch = vi.fn().mockResolvedValueOnce(reply({ content: null, tool_calls: calls }, 'length'));
        const a = agentWith({}, {}, stubRegistry({ execute }));
        await expect(a.processMessage('q')).rejects.toMatchObject({
            lengthLimited: true,
            message: expect.stringContaining('while writing a tool call, so the call was not run'),
        });
        expect(execute).not.toHaveBeenCalled();
        expect(global.fetch).toHaveBeenCalledTimes(1);   // no retry, no further round
    });

    it('runs neither a cut-off tool call with half-written arguments', async () => {
        const execute = vi.fn();
        global.fetch = vi.fn().mockResolvedValueOnce(reply({ content: null, tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'query', arguments: '{"sql_query": "SELECT * FROM read_parq' } }] }, 'length'));
        await expect(agentWith({}, { max_tokens: 1024 }, stubRegistry({ execute })).processMessage('q'))
            .rejects.toThrow(/max_tokens: 1024\) while writing a tool call/);
        expect(execute).not.toHaveBeenCalled();
    });

    it('treats an embedded (text-dialect) tool call cut off at the limit the same way', async () => {
        const execute = vi.fn();
        global.fetch = vi.fn().mockResolvedValueOnce(reply({
            content: '<tool_call>{"name": "query", "arguments": {"sql_query": "SELECT 1"}}</tool_call>' }, 'length'));
        await expect(agentWith({}, {}, stubRegistry({ execute })).processMessage('q')).rejects.toThrow(/tool call/);
        expect(execute).not.toHaveBeenCalled();
    });

    it('reports a budget spent on reasoning, with no answer', async () => {
        global.fetch = vi.fn().mockResolvedValueOnce(reply({ content: '', reasoning_content: 'Let me think… '.repeat(50) }, 'length'));
        await expect(agentWith().processMessage('q')).rejects.toThrow(/before it produced an answer/);
    });

    it('keeps a cut-off failure out of the conversation history', async () => {
        global.fetch = vi.fn()
            .mockResolvedValueOnce(reply({ content: null, tool_calls: [
                { id: 'c1', type: 'function', function: { name: 'query', arguments: '{"sql_q' } }] }, 'length'))
            .mockResolvedValueOnce(reply({ content: 'Fine now.' }, 'stop'));
        const a = agentWith();
        await expect(a.processMessage('first')).rejects.toThrow();
        await a.processMessage('second');
        const history = sentPayload(1).messages;
        expect(history.some(m => (m.tool_calls || []).length)).toBe(false);
        expect(history.filter(m => m.role === 'user').map(m => m.content)).toEqual(['first', 'second']);
    });

    // Live, 2026-10-06, z-ai/glm-5.2 via OpenRouter, max_tokens 300 and 400: the
    // tool call was cut off mid-arguments (invalid JSON) yet came back as
    // finish_reason "tool_calls", with native_finish_reason "length" and
    // completion_tokens equal to the cap.
    const glmCut = { content: '', tool_calls: [{ id: 'c1', type: 'function', function: {
        name: 'query', arguments: '{"sql_query": "SELECT CASE WHEN EXTRACT(YEAR FROM c.signup' } }] };

    it("catches a cut-off call reported as 'tool_calls' through native_finish_reason (GLM-5.2 via OpenRouter)", async () => {
        const execute = vi.fn();
        global.fetch = vi.fn().mockResolvedValueOnce(reply(glmCut, 'tool_calls',
            { choice: { native_finish_reason: 'length' }, usage: { completion_tokens: 400 } }));
        await expect(agentWith({}, { max_tokens: 400 }, stubRegistry({ execute })).processMessage('q'))
            .rejects.toThrow(/while writing a tool call/);
        expect(execute).not.toHaveBeenCalled();
    });

    it('catches it from the completion count reaching the cap alone', async () => {
        const execute = vi.fn();
        global.fetch = vi.fn().mockResolvedValueOnce(reply(glmCut, 'tool_calls', { usage: { completion_tokens: 300 } }));
        await expect(agentWith({}, { max_tokens: 300 }, stubRegistry({ execute })).processMessage('q'))
            .rejects.toThrow(/max_tokens: 300/);
        expect(execute).not.toHaveBeenCalled();
    });

    it('does not read a count under the cap, or any count with no cap set, as a cut-off', async () => {
        global.fetch = vi.fn()
            .mockResolvedValueOnce(reply({ content: 'Short.' }, 'stop', { usage: { completion_tokens: 299 } }))
            .mockResolvedValueOnce(reply({ content: 'Long but complete.' }, 'stop', { usage: { completion_tokens: 50000 } }));
        expect((await agentWith({}, { max_tokens: 300 }).processMessage('q')).truncated).toBeUndefined();
        expect((await agentWith().processMessage('q')).truncated).toBeUndefined();
    });

    it('leaves normal responses alone', async () => {
        global.fetch = vi.fn().mockResolvedValueOnce(reply({ content: 'Complete answer.' }, 'stop'));
        const res = await agentWith({}, { max_tokens: 512 }).processMessage('q');
        expect(res.response).toBe('Complete answer.');
        expect(res.truncated).toBeUndefined();
    });
});
