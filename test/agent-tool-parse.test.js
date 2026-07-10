import { describe, it, expect, vi, afterEach } from 'vitest';
import { Agent } from '../app/agent.js';

// Regression tests for #288: the tool-call parser used to fail silently and
// terminally on malformed calls, killing runs from otherwise-capable weaker
// models. These cover the three observed failure modes plus the helpers.

const stubRegistry = (overrides = {}) => ({
    getToolsForLLM: () => [],
    isLocal: () => true,
    has: (name) => ['get_schema', 'query', 'set_filter', 'clear_filter',
        'list_datasets', 'show_layer'].includes(name),
    execute: async () => ({ result: '' }),
    ...overrides,
});

const baseConfig = (overrides = {}) => ({
    llm_models: [{ value: 'm', endpoint: 'https://x/v1', api_key: 'k' }],
    ...overrides,
});

const okText = (content) => ({
    ok: true,
    json: async () => ({ choices: [{ message: { role: 'assistant', content } }] }),
});

const agentFor = (registryOverrides = {}) =>
    new Agent(baseConfig(), stubRegistry(registryOverrides));

describe('parseEmbeddedToolCalls — tolerant extraction (#288)', () => {
    it('parses a well-formed embedded call (baseline)', () => {
        const a = agentFor();
        const calls = a.parseEmbeddedToolCalls(
            '<tool_call>{"name": "get_schema", "arguments": {"dataset_id": "ebsa"}}</tool_call>');
        expect(calls).toEqual([{ name: 'get_schema', args: { dataset_id: 'ebsa' } }]);
    });

    it('recovers a mismatched closing tag (failure mode 1)', () => {
        const a = agentFor();
        // Wrong wrapper close tag: </parameter> instead of </tool_call>. The old
        // regex required an exact </tool_call> and no interior '<' → zero matches.
        const calls = a.parseEmbeddedToolCalls(
            '<tool_call>{"name": "get_schema", "arguments": {"dataset_id":"ebsa"}} </parameter>');
        expect(calls).toEqual([{ name: 'get_schema', args: { dataset_id: 'ebsa' } }]);
    });

    it('recovers a missing closing tag (EOF terminator)', () => {
        const a = agentFor();
        const calls = a.parseEmbeddedToolCalls(
            'sure, calling it:\n<tool_call>{"name": "query", "arguments": {"sql": "select 1"}}');
        expect(calls).toEqual([{ name: 'query', args: { sql: 'select 1' } }]);
    });

    it('recovers an inner JSON with a trailing extra brace (lenient parse)', () => {
        const a = agentFor();
        const calls = a.parseEmbeddedToolCalls(
            '<tool_call>{"name": "get_schema", "arguments": {"dataset_id": "ebsa"}}}</tool_call>');
        expect(calls).toEqual([{ name: 'get_schema', args: { dataset_id: 'ebsa' } }]);
    });

    it('does not break on interior "<" that is not a closing tag (filter operators)', () => {
        const a = agentFor();
        // A '<' comparison operator inside args must NOT terminate extraction —
        // the old [^<]+ regex broke on this entirely.
        const calls = a.parseEmbeddedToolCalls(
            '<tool_call>{"name": "set_filter", "arguments": {"expr": ["<", 5]}}</tool_call>');
        expect(calls).toEqual([{ name: 'set_filter', args: { expr: ['<', 5] } }]);
    });

    it('parses the function-call shape: name({...})', () => {
        const a = agentFor();
        const calls = a.parseEmbeddedToolCalls(
            '<tool_call>get_schema({"dataset_id": "ebsa"})</tool_call>');
        expect(calls).toEqual([{ name: 'get_schema', args: { dataset_id: 'ebsa' } }]);
    });

    it('parses a bare known tool name with no args', () => {
        const a = agentFor();
        const calls = a.parseEmbeddedToolCalls('<tool_call>query</tool_call>');
        expect(calls).toEqual([{ name: 'query', args: {} }]);
    });

    it('parses multiple embedded calls in one message', () => {
        const a = agentFor();
        const calls = a.parseEmbeddedToolCalls(
            '<tool_call>{"name":"get_schema","arguments":{"dataset_id":"a"}}</tool_call>'
            + '<tool_call>{"name":"query","arguments":{"sql":"select 1"}}</tool_call>');
        expect(calls).toEqual([
            { name: 'get_schema', args: { dataset_id: 'a' } },
            { name: 'query', args: { sql: 'select 1' } },
        ]);
    });

    it('returns [] on structurally-invalid inner JSON (failure mode 3)', () => {
        const a = agentFor();
        // {"function:get_schema", ...} is not recoverable JSON, not a func-call
        // shape, and not a bare name → 0 calls. Recovery is handled by the loop.
        const calls = a.parseEmbeddedToolCalls(
            '<tool_call>{"function:get_schema", "parameters":{"dataset_id":"ebsa"}}</tool_call>');
        expect(calls).toEqual([]);
    });

    it('returns [] on empty/absent content', () => {
        const a = agentFor();
        expect(a.parseEmbeddedToolCalls('')).toEqual([]);
        expect(a.parseEmbeddedToolCalls(null)).toEqual([]);
        expect(a.parseEmbeddedToolCalls('just a normal answer')).toEqual([]);
    });
});

describe('parseEmbeddedToolCalls — dialect tolerance (#295)', () => {
    // The barred-owl / qwen-nimbus leaks: host returned these as content and the
    // old parser only knew <tool_call>{name,arguments}, so they surfaced to the user.

    it('recognizes the <tool_code> wrapper (Gemini-style) with parameters alias', () => {
        const a = agentFor();
        const calls = a.parseEmbeddedToolCalls(
            '<tool_code>{"name": "clear_filter", "parameters": {"layer_id": "barred-owl/nso-ccap"}}</tool_code>');
        expect(calls).toEqual([{ name: 'clear_filter', args: { layer_id: 'barred-owl/nso-ccap' } }]);
    });

    it('recovers a lone quoted name against a known tool: {"list_datasets"}', () => {
        const a = agentFor();
        const calls = a.parseEmbeddedToolCalls('<tool_call>{"list_datasets"}');
        expect(calls).toEqual([{ name: 'list_datasets', args: {} }]);
    });

    it('yields nothing on truly-garbled content (recovery path handles it)', () => {
        const a = agentFor();
        expect(a.parseEmbeddedToolCalls('<tool_call>{"function_call> </function_call>')).toEqual([]);
    });

    it('parses bare (unwrapped), concatenated nested calls with parameters alias', () => {
        const a = agentFor();
        const calls = a.parseEmbeddedToolCalls(
            '{"type": "function", "function": {"name": "query", "parameters": {"sql_query": "SELECT 1"}}}'
            + '{"type": "function", "function": {"name": "query", "parameters": {"sql_query": "SELECT 2"}}}');
        expect(calls).toEqual([
            { name: 'query', args: { sql_query: 'SELECT 1' } },
            { name: 'query', args: { sql_query: 'SELECT 2' } },
        ]);
    });

    it('parses the nested OpenAI shape inside a <tool_call> wrapper', () => {
        const a = agentFor();
        const calls = a.parseEmbeddedToolCalls(
            '<tool_call>{"type": "function", "function": {"name": "get_schema", '
            + '"parameters": {"dataset_id": "barred-owl"}}}</tool_call>');
        expect(calls).toEqual([{ name: 'get_schema', args: { dataset_id: 'barred-owl' } }]);
    });

    it('parses a nested call followed by concatenated query calls in one wrapper', () => {
        const a = agentFor();
        const calls = a.parseEmbeddedToolCalls(
            '<tool_call>{"type": "function", "function": {"name": "show_layer", "parameters": {"layer_id": "x"}}}'
            + '{"type": "function", "function": {"name": "query", "parameters": {"sql_query": "SELECT 1"}}}'
            + '{"type": "function", "function": {"name": "query", "parameters": {"sql_query": "SELECT 2"}}}</tool_call>');
        expect(calls).toEqual([
            { name: 'show_layer', args: { layer_id: 'x' } },
            { name: 'query', args: { sql_query: 'SELECT 1' } },
            { name: 'query', args: { sql_query: 'SELECT 2' } },
        ]);
    });

    it('parses the Hermes <function=NAME> dialect, incl. the corrupted live form', () => {
        const a = agentFor();
        // Verbatim from barred-owl/qwen proxy logs — the one dialect that still
        // leaked under the #288 recovery net before this handler.
        const calls = a.parseEmbeddedToolCalls(
            '<tool_call>\n<function=query", "arguments": {"sql_query": "SELECT DISTINCT i.HEXID '
            + "FROM read_parquet('s3://public-barred-owl/inputs/hex/h0=*/data_0.parquet') i "
            + 'WHERE i.nso_ccap = 20"}}\n</tool_call>');
        expect(calls).toEqual([{ name: 'query', args: {
            sql_query: "SELECT DISTINCT i.HEXID FROM read_parquet('s3://public-barred-owl/inputs/hex/h0=*/data_0.parquet') i WHERE i.nso_ccap = 20",
        } }]);
    });

    it('unwraps a lone arguments/parameters envelope in the <function=> dialect', () => {
        const a = agentFor();
        const calls = a.parseEmbeddedToolCalls(
            '<tool_call><function=get_schema>\n{"parameters": {"dataset_id": "barred-owl"}}</function></tool_call>');
        expect(calls).toEqual([{ name: 'get_schema', args: { dataset_id: 'barred-owl' } }]);
    });

    it('does NOT misread stray JSON in a plain final answer as a call', () => {
        const a = agentFor();
        // A style blob with no name / no args-key / unregistered → not a call.
        expect(a.parseEmbeddedToolCalls(
            'Here is the style you asked for: {"fill-color": "#ff0000", "fill-opacity": 0.5}')).toEqual([]);
        // A flat object whose name is not a registered tool and carries no args key.
        expect(a.parseEmbeddedToolCalls('{"name": "fibonacci"}')).toEqual([]);
    });
});

describe('stripEmbeddedCalls — display cleanup (#295)', () => {
    it('strips a <tool_code> wrapper from displayed content', () => {
        const a = agentFor();
        expect(a.stripEmbeddedCalls(
            'Filtering now.\n<tool_code>{"name": "clear_filter", "parameters": {}}</tool_code>'))
            .toBe('Filtering now.');
    });

    it('strips an unclosed wrapper through EOF', () => {
        const a = agentFor();
        expect(a.stripEmbeddedCalls(
            'One moment.\n<tool_call>{"name": "query", "arguments": {"sql": "select 1"}}'))
            .toBe('One moment.');
    });

    it('excises bare tool-call JSON so it does not echo to the user', () => {
        const a = agentFor();
        expect(a.stripEmbeddedCalls(
            'Running the query. {"type": "function", "function": {"name": "query", "parameters": {"sql_query": "SELECT 1"}}}'))
            .toBe('Running the query.');
    });

    it('leaves a genuine final answer (with incidental JSON) intact', () => {
        const a = agentFor();
        const text = 'The style is {"fill-color": "#ff0000"} — apply it in the panel.';
        expect(a.stripEmbeddedCalls(text)).toBe(text);
    });
});

describe('parseLenientJSON / _decodeFirstJSON (#288)', () => {
    it('parses valid JSON strictly', () => {
        const a = agentFor();
        expect(a.parseLenientJSON('{"a": 1}')).toEqual({ a: 1 });
    });

    it('recovers a trailing extra brace', () => {
        const a = agentFor();
        expect(a.parseLenientJSON('{"dataset_id": "ebsa"}}')).toEqual({ dataset_id: 'ebsa' });
    });

    it('ignores trailing prose after a complete object', () => {
        const a = agentFor();
        expect(a.parseLenientJSON('{"a": 1} and then some words')).toEqual({ a: 1 });
    });

    it('does not confuse a brace inside a string for the closer', () => {
        const a = agentFor();
        expect(a.parseLenientJSON('{"a": "}"}}')).toEqual({ a: '}' });
    });

    it('returns undefined when nothing valid can be extracted', () => {
        const a = agentFor();
        expect(a.parseLenientJSON('not json at all')).toBeUndefined();
        expect(a.parseLenientJSON('')).toBeUndefined();
        expect(a.parseLenientJSON(null)).toBeUndefined();
    });
});

describe('normalizeToolCallArguments (#288 failure mode 2)', () => {
    it('repairs a trailing extra brace so history is valid JSON', () => {
        const a = agentFor();
        const message = {
            role: 'assistant',
            tool_calls: [{ id: 'c1', type: 'function',
                function: { name: 'get_schema', arguments: '{"dataset_id": "ebsa"}}' } }],
        };
        a.normalizeToolCallArguments(message);
        expect(message.tool_calls[0].function.arguments).toBe('{"dataset_id":"ebsa"}');
        // and it must round-trip cleanly (the check that prevents the 400)
        expect(() => JSON.parse(message.tool_calls[0].function.arguments)).not.toThrow();
    });

    it('replaces unrecoverable arguments with {}', () => {
        const a = agentFor();
        const message = {
            role: 'assistant',
            tool_calls: [{ id: 'c1', type: 'function',
                function: { name: 'get_schema', arguments: 'total garbage' } }],
        };
        a.normalizeToolCallArguments(message);
        expect(message.tool_calls[0].function.arguments).toBe('{}');
    });

    it('canonicalizes an object-typed arguments field to a string', () => {
        const a = agentFor();
        const message = {
            role: 'assistant',
            tool_calls: [{ id: 'c1', type: 'function',
                function: { name: 'get_schema', arguments: { dataset_id: 'ebsa' } } }],
        };
        a.normalizeToolCallArguments(message);
        expect(message.tool_calls[0].function.arguments).toBe('{"dataset_id":"ebsa"}');
    });

    it('is a no-op for messages without tool_calls', () => {
        const a = agentFor();
        const message = { role: 'assistant', content: 'hi' };
        expect(() => a.normalizeToolCallArguments(message)).not.toThrow();
        expect(message).toEqual({ role: 'assistant', content: 'hi' });
    });
});

describe('looksLikeAttemptedToolCall (#288)', () => {
    it('flags a stray <tool_call tag', () => {
        expect(agentFor().looksLikeAttemptedToolCall('<tool_call>oops')).toBe(true);
    });
    it('flags a stray <tool_code tag (#295)', () => {
        expect(agentFor().looksLikeAttemptedToolCall('<tool_code>oops')).toBe(true);
    });
    it('flags JSON-shaped call keys', () => {
        expect(agentFor().looksLikeAttemptedToolCall('{"function": "get_schema"}')).toBe(true);
    });
    it('flags a bare call against a known tool', () => {
        expect(agentFor().looksLikeAttemptedToolCall('get_schema({"dataset_id": "ebsa"})')).toBe(true);
    });
    it('does not flag a call against an unknown name', () => {
        expect(agentFor().looksLikeAttemptedToolCall('fibonacci({"n": 10})')).toBe(false);
    });
    it('does not flag a plain final answer', () => {
        expect(agentFor().looksLikeAttemptedToolCall('The answer is 42 square kilometers.')).toBe(false);
    });
});

describe('looksLikeAttemptedToolCall — non-JSON dialect tail (#297)', () => {
    // Each row of #297: forms that leak with ZERO recovery today because neither
    // the parser nor this heuristic recognized them. Flagging here at least fires
    // the #288 re-prompt. All gated on the tool registry.
    const a = () => agentFor();

    it('flags a bare python-call, double quotes', () => {
        expect(a().looksLikeAttemptedToolCall('show_layer(layer_id="barred-owl/bo-occ")')).toBe(true);
    });
    it('flags a bare python-call, single quotes', () => {
        expect(a().looksLikeAttemptedToolCall("show_layer(layer_id='barred-owl/bo-occ')")).toBe(true);
    });
    it('flags a tool-name-as-tag with JSON body', () => {
        expect(a().looksLikeAttemptedToolCall('<show_layer>{"layer_id":"barred-owl/bo-occ"}</show_layer>')).toBe(true);
    });
    it('flags a tool-name-as-tag with XML body', () => {
        expect(a().looksLikeAttemptedToolCall('<show_layer><layer_id>barred-owl/bo-occ</layer_id></show_layer>')).toBe(true);
    });
    it('flags the mangled <parameter=…> form', () => {
        expect(a().looksLikeAttemptedToolCall(
            '<parameter=function>\nshow_layer\n</parameter>\n<parameter=layer_id>\nx\n</parameter>')).toBe(true);
    });
    it('flags Claude <model_calls>/<invoke name=…> XML', () => {
        expect(a().looksLikeAttemptedToolCall(
            '<model_calls>\n<invoke name="get_schema">\n<parameter name="dataset_id">barred-owl</parameter>\n</invoke>\n</model_calls>')).toBe(true);
    });
    it('flags a tool tag even when hallucinated reasoning tags precede it', () => {
        // Real barred-owl leak: <antThinking>…</antThinking> then the actual
        // <show_layer><layer_id>… tag. Must scan past the first <word>.
        expect(a().looksLikeAttemptedToolCall(
            "I'll display the layer.\n\n<antThinking>\nreasoning here\n</antThinking>\n\n"
            + '<show_layer>\n<layer_id>\nbarred-owl/bo-occ\n</layer_id>\n</show_layer>')).toBe(true);
    });
    it('does not flag prose that merely names a tool without a call/tag', () => {
        expect(a().looksLikeAttemptedToolCall('The query returned 5 rows; I can show_layer next if you like.')).toBe(false);
        expect(a().looksLikeAttemptedToolCall('I used get_schema earlier to inspect the columns.')).toBe(false);
    });
    it('does not flag a tool word followed by a *parenthetical*, not a call', () => {
        // `query` is both a registered tool and a common English word: a final
        // answer that mentions it parenthetically must NOT trip the re-prompt.
        // The `(` has to be followed by an arg-shaped token (quote / brace / kwarg=).
        expect(a().looksLikeAttemptedToolCall('The query (running over the H3 parquet) returned 5 rows.')).toBe(false);
        expect(a().looksLikeAttemptedToolCall('Here is the result of set_filter (applied earlier).')).toBe(false);
        expect(a().looksLikeAttemptedToolCall('You can call query() and show_layer() next if you like.')).toBe(false);
    });
});

describe('agent loop — malformed-call recovery (#288 failure mode 1/3)', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    it('re-prompts on an unparseable call instead of terminating, then completes', async () => {
        // Round 1: garbage that looks like a call but yields 0 parsed calls.
        // Round 2 (after the corrective nudge): a clean final answer.
        global.fetch = vi.fn()
            .mockResolvedValueOnce(okText('<tool_call>{"function:get_schema", "parameters":{}}</tool_call>'))
            .mockResolvedValueOnce(okText('The answer is 42.'));
        const agent = agentFor();
        agent.autoApprove = true;

        const { response } = await agent.processMessage('how much?');

        expect(response).toBe('The answer is 42.');
        expect(global.fetch.mock.calls.length).toBe(2); // it recovered, didn't stop at round 1
    });

    it('stops re-prompting after the cap and falls through to the content', async () => {
        // The model NEVER produces a parseable call — always garbage. The loop
        // must bound the corrective retries (2) and then return the content
        // rather than looping forever.
        global.fetch = vi.fn().mockResolvedValue(
            okText('<tool_call>{"function:get_schema", "parameters":{}}</tool_call>'));
        const agent = agentFor();
        agent.autoApprove = true;

        const { response } = await agent.processMessage('how much?');

        // 1 initial + 2 corrective retries = 3 calls, then falls through.
        expect(global.fetch.mock.calls.length).toBe(3);
        expect(response).toContain('<tool_call>');
    });

    it('executes a leaked <tool_code> call instead of surfacing it as text (#295)', async () => {
        // Round 1: host returns the call as content in a foreign dialect (no
        // structured tool_calls). Round 2: the clean final answer after it ran.
        global.fetch = vi.fn()
            .mockResolvedValueOnce(okText(
                '<tool_code>{"type": "function", "function": {"name": "query", '
                + '"parameters": {"sql_query": "SELECT 1"}}}</tool_code>'))
            .mockResolvedValueOnce(okText('Done — 1 row.'));
        const executed = [];
        const agent = agentFor({
            execute: async (name, args) => { executed.push({ name, args }); return { result: 'ok' }; },
        });
        agent.autoApprove = true;

        const { response } = await agent.processMessage('run it');

        expect(executed).toEqual([{ name: 'query', args: { sql_query: 'SELECT 1' } }]);
        expect(response).toBe('Done — 1 row.');
    });

    it('does not re-prompt a genuine final answer', async () => {
        global.fetch = vi.fn().mockResolvedValueOnce(okText('The area is 42 sq km.'));
        const agent = agentFor();
        agent.autoApprove = true;

        const { response } = await agent.processMessage('how much?');

        expect(response).toBe('The area is 42 sq km.');
        expect(global.fetch.mock.calls.length).toBe(1);
    });
});
