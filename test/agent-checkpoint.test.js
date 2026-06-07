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
