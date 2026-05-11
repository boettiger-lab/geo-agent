import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Transcriber } from '../app/transcriber.js';

const okResponse = (text) => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: text } }] }),
});

const errResponse = (status, body = 'oops') => ({
    ok: false,
    status,
    text: async () => body,
});

describe('Transcriber constructor', () => {
    it('throws when modelCfg is missing or has no value', () => {
        expect(() => new Transcriber()).toThrow(/value/);
        expect(() => new Transcriber({})).toThrow(/value/);
        expect(() => new Transcriber({ value: '' })).toThrow(/value/);
    });

    it('accepts a modelCfg with at least a value field', () => {
        expect(() => new Transcriber({ value: 'whisper-x' })).not.toThrow();
    });
});

describe('Transcriber.transcribe', () => {
    let originalFetch;
    beforeEach(() => { originalFetch = global.fetch; });
    afterEach(() => { global.fetch = originalFetch; });

    it('POSTs to <endpoint>/chat/completions with the audio payload and returns trimmed text', async () => {
        global.fetch = vi.fn(async () => okResponse('  hello there  '));
        const t = new Transcriber({ value: 'gemma4', endpoint: 'https://llm/v1', api_key: 'k' });

        const out = await t.transcribe({ data: 'BASE64', format: 'wav' });

        expect(out).toBe('hello there');
        expect(global.fetch).toHaveBeenCalledOnce();
        const [url, opts] = global.fetch.mock.calls[0];
        expect(url).toBe('https://llm/v1/chat/completions');
        expect(opts.headers.Authorization).toBe('Bearer k');
        const body = JSON.parse(opts.body);
        expect(body.model).toBe('gemma4');
        expect(body.messages[1].content[0]).toEqual({
            type: 'input_audio',
            input_audio: { data: 'BASE64', format: 'wav' },
        });
    });

    it('appends /chat/completions when the configured endpoint omits it', async () => {
        global.fetch = vi.fn(async () => okResponse('x'));
        const t = new Transcriber({ value: 'm', endpoint: 'https://llm/v1/' });
        await t.transcribe({ data: 'b', format: 'wav' });
        expect(global.fetch.mock.calls[0][0]).toBe('https://llm/v1/chat/completions');
    });

    it('uses the default endpoint when none is configured', async () => {
        global.fetch = vi.fn(async () => okResponse('x'));
        const t = new Transcriber({ value: 'm' });
        await t.transcribe({ data: 'b', format: 'wav' });
        expect(global.fetch.mock.calls[0][0]).toBe('https://llm-proxy.nrp-nautilus.io/v1/chat/completions');
    });

    it('falls back to "EMPTY" Authorization when api_key is absent', async () => {
        global.fetch = vi.fn(async () => okResponse('x'));
        const t = new Transcriber({ value: 'm' });
        await t.transcribe({ data: 'b', format: 'wav' });
        expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer EMPTY');
    });

    it('throws an error including the HTTP status on a non-OK response', async () => {
        global.fetch = vi.fn(async () => errResponse(500, 'server boom'));
        const t = new Transcriber({ value: 'm' });
        await expect(t.transcribe({ data: 'b', format: 'wav' }))
            .rejects.toThrow(/500.*server boom/);
    });

    it('returns empty string when the response has no content', async () => {
        global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: {} }] }) }));
        const t = new Transcriber({ value: 'm' });
        expect(await t.transcribe({ data: 'b', format: 'wav' })).toBe('');
    });

    it('forwards a user-supplied AbortSignal to fetch', async () => {
        global.fetch = vi.fn(async () => okResponse('x'));
        const t = new Transcriber({ value: 'm' });
        const ctrl = new AbortController();
        await t.transcribe({ data: 'b', format: 'wav' }, { signal: ctrl.signal });
        expect(global.fetch.mock.calls[0][1].signal).toBe(ctrl.signal);
    });
});
