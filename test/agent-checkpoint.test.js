import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent } from '../app/agent.js';

const stubRegistry = (overrides = {}) => ({
    getToolsForLLM: () => [],
    isLocal: () => true,
    execute: async () => ({ result: '' }),
    ...overrides,
});

const baseConfig = (overrides = {}) => ({
    llm_models: [{ value: 'm', endpoint: 'https://x/v1', api_key: 'k' }],
    ...overrides,
});

const okText = (content = 'done') => ({
    ok: true,
    json: async () => ({ choices: [{ message: { role: 'assistant', content } }] }),
});

const okToolCall = (name = 'remote_tool', id = 'c1') => ({
    ok: true,
    json: async () => ({
        choices: [{ message: { role: 'assistant', content: null, tool_calls: [
            { id, type: 'function', function: { name, arguments: '{}' } },
        ] } }],
    }),
});

describe('Agent threshold configuration', () => {
    it('defaults to 15 (auto) and 100 (manual)', () => {
        const agent = new Agent(baseConfig(), stubRegistry());
        expect(agent.maxToolCalls).toBe(15);
        expect(agent.maxToolCallsManual).toBe(100);
    });

    it('reads overrides from config', () => {
        const agent = new Agent(
            baseConfig({ max_tool_calls: 8, max_tool_calls_manual: 50 }),
            stubRegistry(),
        );
        expect(agent.maxToolCalls).toBe(8);
        expect(agent.maxToolCallsManual).toBe(50);
    });

    it('activeThreshold picks the mode-specific value', () => {
        const agent = new Agent(baseConfig({ max_tool_calls: 8, max_tool_calls_manual: 50 }), stubRegistry());
        agent.autoApprove = true;
        expect(agent.activeThreshold()).toBe(8);
        agent.autoApprove = false;
        expect(agent.activeThreshold()).toBe(50);
    });
});

describe('Agent remote-round counting', () => {
    beforeEach(() => { vi.useRealTimers(); });
    afterEach(() => { vi.restoreAllMocks(); });

    it('initializes suspendedTurn to null', () => {
        const agent = new Agent(baseConfig(), stubRegistry());
        expect(agent.suspendedTurn).toBe(null);
    });

    it('does not checkpoint a turn that only uses local tools', async () => {
        // One local tool round, then a final text answer.
        global.fetch = vi.fn()
            .mockResolvedValueOnce(okToolCall('local_tool'))
            .mockResolvedValueOnce(okText('all done'));
        const agent = new Agent(
            baseConfig({ max_tool_calls: 1 }),    // tiny threshold
            stubRegistry({ isLocal: () => true }), // every call is local
        );
        agent.autoApprove = true;
        const { response } = await agent.processMessage('hi');
        expect(response).toBe('all done');
        expect(agent.suspendedTurn).toBe(null);
    });
});

describe('Agent checkpoint', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    it('pauses at the threshold, makes a no-tools summary call, and suspends', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(okToolCall('remote_tool'))      // round 1 (remote)
            .mockResolvedValueOnce(okText('Progress: ran 1 query; next I would join counties.'));
        global.fetch = fetchMock;

        const onCheckpoint = vi.fn();
        const agent = new Agent(
            baseConfig({ max_tool_calls: 1 }),
            stubRegistry({ isLocal: () => false, execute: async () => ({ result: 'rows', sqlQuery: 'SELECT 1' }) }),
        );
        agent.autoApprove = true;
        agent.onCheckpoint = onCheckpoint;

        const { response, checkpoint } = await agent.processMessage('hard question');

        expect(checkpoint).toBe(true);
        expect(response).toContain('Progress');
        expect(onCheckpoint).toHaveBeenCalledOnce();
        expect(agent.suspendedTurn).not.toBe(null);
        const summaryBody = JSON.parse(fetchMock.mock.calls[1][1].body);
        expect(summaryBody.tool_choice).toBe('none');
        expect(summaryBody.tools).toBeUndefined();
    });

    it('does not checkpoint when threshold is 0 (disabled)', async () => {
        global.fetch = vi.fn()
            .mockResolvedValueOnce(okToolCall('remote_tool'))
            .mockResolvedValueOnce(okToolCall('remote_tool', 'c2'))
            .mockResolvedValueOnce(okText('final'));
        const agent = new Agent(
            baseConfig({ max_tool_calls: 0 }),
            stubRegistry({ isLocal: () => false }),
        );
        agent.autoApprove = true;
        const { response, checkpoint } = await agent.processMessage('q');
        expect(checkpoint).toBeFalsy();
        expect(response).toBe('final');
    });
});

describe('Agent resume', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    it('resumes the saved turnMessages instead of rebuilding, then clears on final answer', async () => {
        global.fetch = vi.fn()
            .mockResolvedValueOnce(okToolCall('remote_tool'))
            .mockResolvedValueOnce(okText('Summary so far.'));
        const agent = new Agent(
            baseConfig({ max_tool_calls: 1 }),
            stubRegistry({ isLocal: () => false, execute: async () => ({ result: 'rows', sqlQuery: 'SELECT 1' }) }),
        );
        agent.autoApprove = true;
        await agent.processMessage('hard question');
        expect(agent.suspendedTurn).not.toBe(null);
        const savedTurn = agent.suspendedTurn.turnMessages;
        const lenBeforeResume = savedTurn.length;

        let sentMessages = null;
        global.fetch = vi.fn(async (url, opts) => {
            sentMessages = JSON.parse(opts.body).messages;
            return okText('Final answer.');
        });
        const { response } = await agent.processMessage('continue');

        expect(response).toBe('Final answer.');
        expect(sentMessages.length).toBe(lenBeforeResume + 1); // + the "continue" user msg
        expect(sentMessages[sentMessages.length - 1]).toEqual({ role: 'user', content: 'continue' });
        expect(agent.suspendedTurn).toBe(null);
    });
});
