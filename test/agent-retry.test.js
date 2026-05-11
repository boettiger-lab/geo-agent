import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent } from '../app/agent.js';

const stubToolRegistry = {
    getToolsForLLM: () => [],
    isLocal: () => true,
    execute: async () => ({ result: '' }),
};

const makeAgent = () => {
    const agent = new Agent(
        { llm_models: [{ value: 'm', endpoint: 'https://x/v1', api_key: 'k' }] },
        stubToolRegistry,
    );
    return agent;
};

const okResponse = (content = 'hello') => ({
    ok: true,
    json: async () => ({ choices: [{ message: { role: 'assistant', content } }] }),
});

const errResponse = (status, body = 'oops') => ({
    ok: false,
    status,
    text: async () => body,
});

describe('Agent._isTransientLLMError', () => {
    const agent = makeAgent();

    it('returns true for client-side timeout', () => {
        const err = new Error('Request timed out after 300 seconds');
        err.timedOut = true;
        expect(agent._isTransientLLMError(err)).toBe(true);
    });

    it('returns true for network TypeError', () => {
        const err = new TypeError('fetch failed');
        expect(agent._isTransientLLMError(err)).toBe(true);
    });

    it.each([500, 502, 503, 504, 599])('returns true for HTTP %i', (status) => {
        const err = new Error('LLM API error');
        err.status = status;
        expect(agent._isTransientLLMError(err)).toBe(true);
    });

    it.each([400, 401, 403, 404, 429])('returns false for HTTP %i', (status) => {
        const err = new Error('LLM API error');
        err.status = status;
        expect(agent._isTransientLLMError(err)).toBe(false);
    });

    it('returns false for AbortError (user-pressed Stop)', () => {
        const err = new DOMException('Aborted', 'AbortError');
        expect(agent._isTransientLLMError(err)).toBe(false);
    });

    it('returns false for plain Error with no transient signal', () => {
        expect(agent._isTransientLLMError(new Error('parse error'))).toBe(false);
    });
});

describe('Agent._attemptLLMCall', () => {
    let agent;

    beforeEach(() => {
        agent = makeAgent();
        agent.abortController = new AbortController();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('returns the LLM message on success', async () => {
        global.fetch = vi.fn(async () => okResponse('hi'));
        const msg = await agent._attemptLLMCall('https://x/chat/completions', { api_key: 'k' }, {}, 1000);
        expect(msg.content).toBe('hi');
    });

    it('throws timeout error with timedOut=true after timeoutMs', async () => {
        vi.useFakeTimers();
        // Hang the fetch indefinitely; we'll abort via the timeout
        global.fetch = vi.fn((url, opts) => new Promise((_, reject) => {
            opts.signal.addEventListener('abort', () => {
                reject(new DOMException('Aborted', 'AbortError'));
            });
        }));
        const settled = agent._attemptLLMCall('https://x', { api_key: 'k' }, {}, 5000)
            .then(() => null, (e) => e);
        await vi.advanceTimersByTimeAsync(5000);
        const error = await settled;
        expect(error).toMatchObject({
            timedOut: true,
            message: expect.stringContaining('timed out after 5 seconds'),
        });
    });

    it('throws AbortError (no timedOut) when user-pressed Stop fires during fetch', async () => {
        global.fetch = vi.fn((url, opts) => new Promise((_, reject) => {
            opts.signal.addEventListener('abort', () => {
                reject(new DOMException('Aborted', 'AbortError'));
            });
        }));
        const promise = agent._attemptLLMCall('https://x', { api_key: 'k' }, {}, 60000);
        // User-pressed Stop forwards through this.abortController
        agent.abortController.abort();
        await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('does not abort the turn-level abortController when timeout fires', async () => {
        vi.useFakeTimers();
        global.fetch = vi.fn((url, opts) => new Promise((_, reject) => {
            opts.signal.addEventListener('abort', () => {
                reject(new DOMException('Aborted', 'AbortError'));
            });
        }));
        const settled = agent._attemptLLMCall('https://x', { api_key: 'k' }, {}, 1000)
            .then(() => null, (e) => e);
        await vi.advanceTimersByTimeAsync(1000);
        const error = await settled;
        expect(error).toMatchObject({ timedOut: true });
        // Critical: turn-level controller stays un-aborted so the outer loop's
        // withAbort race remains valid for downstream tool execution on retry.
        expect(agent.abortController.signal.aborted).toBe(false);
    });

    it('throws err with .status on HTTP non-OK', async () => {
        global.fetch = vi.fn(async () => errResponse(503, 'no available server'));
        await expect(
            agent._attemptLLMCall('https://x', { api_key: 'k' }, {}, 1000),
        ).rejects.toMatchObject({
            status: 503,
            message: expect.stringContaining('503'),
        });
    });
});

describe('Agent.callLLM retry orchestration', () => {
    let agent;

    beforeEach(() => {
        agent = makeAgent();
        agent.abortController = new AbortController();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns first-attempt success without retry', async () => {
        global.fetch = vi.fn(async () => okResponse('first ok'));
        const onRetry = vi.fn();
        agent.onRetry = onRetry;

        const msg = await agent.callLLM('https://x/v1', { api_key: 'k' }, [], []);
        expect(msg.content).toBe('first ok');
        expect(global.fetch).toHaveBeenCalledOnce();
        expect(onRetry).not.toHaveBeenCalled();
    });

    it('retries on HTTP 503 and returns retry success', async () => {
        global.fetch = vi.fn()
            .mockResolvedValueOnce(errResponse(503, 'no available server'))
            .mockResolvedValueOnce(okResponse('retry ok'));
        const onRetry = vi.fn();
        agent.onRetry = onRetry;

        const msg = await agent.callLLM('https://x/v1', { api_key: 'k' }, [], []);
        expect(msg.content).toBe('retry ok');
        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(onRetry).toHaveBeenCalledOnce();
        expect(onRetry.mock.calls[0][0]).toMatchObject({ status: 503 });
    });

    it('retries on TypeError (network) and returns retry success', async () => {
        global.fetch = vi.fn()
            .mockRejectedValueOnce(new TypeError('fetch failed'))
            .mockResolvedValueOnce(okResponse('retry ok'));
        const onRetry = vi.fn();
        agent.onRetry = onRetry;

        const msg = await agent.callLLM('https://x/v1', { api_key: 'k' }, [], []);
        expect(msg.content).toBe('retry ok');
        expect(onRetry).toHaveBeenCalledOnce();
    });

    it('does NOT retry on HTTP 401', async () => {
        global.fetch = vi.fn(async () => errResponse(401, 'unauthorized'));
        const onRetry = vi.fn();
        agent.onRetry = onRetry;

        await expect(agent.callLLM('https://x/v1', { api_key: 'k' }, [], []))
            .rejects.toMatchObject({ status: 401 });
        expect(global.fetch).toHaveBeenCalledOnce();
        expect(onRetry).not.toHaveBeenCalled();
    });

    it('does NOT retry on user-pressed Stop (real AbortError)', async () => {
        global.fetch = vi.fn((url, opts) => new Promise((_, reject) => {
            opts.signal.addEventListener('abort', () => {
                reject(new DOMException('Aborted', 'AbortError'));
            });
        }));
        const onRetry = vi.fn();
        agent.onRetry = onRetry;

        const promise = agent.callLLM('https://x/v1', { api_key: 'k' }, [], []);
        agent.abortController.abort();
        await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
        expect(onRetry).not.toHaveBeenCalled();
    });

    it('throws second-attempt error when retry also fails', async () => {
        global.fetch = vi.fn()
            .mockResolvedValueOnce(errResponse(502, 'gateway one'))
            .mockResolvedValueOnce(errResponse(503, 'gateway two'));
        const onRetry = vi.fn();
        agent.onRetry = onRetry;

        await expect(agent.callLLM('https://x/v1', { api_key: 'k' }, [], []))
            .rejects.toMatchObject({ status: 503 });
        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(onRetry).toHaveBeenCalledOnce();
    });
});
