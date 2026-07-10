/**
 * Agent - LLM orchestration loop
 * 
 * Pure logic, no DOM manipulation. Communicates via event callbacks.
 * 
 * Implements the agentic tool-use loop:
 *   1. Send messages + tools to LLM
 *   2. If LLM returns tool_calls → emit proposal → wait for approval → execute → loop
 *   3. If LLM returns text → emit response → done
 * 
 * Supports multiple OpenAI-compatible LLM backends.
 * Handles embedded tool calls (XML tags) from models that don't use structured tool_calls.
 */

// The pinned ref the app was loaded from lives in the module URL itself
// (…/geo-agent@v3.13.1/app/agent.js), so it identifies the exact build with no
// build step. Falls back to 'dev' for local/headless runs (a file:// URL). Used
// only for the X-Client log-attribution header (#254). See `_clientHeaders`.
const APP_VERSION = import.meta.url.match(/geo-agent@([^/]+)/)?.[1] || 'dev';

export class Agent {
    /**
     * @param {Object} config
     * @param {import('./tool-registry.js').ToolRegistry} toolRegistry
     */
    constructor(config, toolRegistry) {
        this.config = config;
        this.toolRegistry = toolRegistry;
        this.systemPrompt = '';
        this.messages = [];
        this.selectedModel = config.llm_model || config.llm_models?.[0]?.value || 'default';
        // Runtime override for model thinking/reasoning, set by the chat-ui toggle.
        // null = no override (fall back to config default, else omit → model default);
        // true/false = user asked for reasoning on/off for subsequent turns. Reset to
        // null on model switch so each model starts from its own configured default.
        this.reasoningOverride = null;
        // Checkpoint thresholds: how many *remote* tool-call rounds before the
        // agent pauses to report progress and ask to continue. Auto-approve uses
        // the tighter value (the checkpoint is the user's periodic gate); manual
        // mode uses a high value since per-call approval is already the guard.
        // null/0 in either disables the checkpoint for that mode.
        this.maxToolCalls = config.max_tool_calls ?? 15;
        this.maxToolCallsManual = config.max_tool_calls_manual ?? 100;
        // In-flight turn state preserved across user messages when a turn pauses
        // at a checkpoint. null when no turn is suspended.
        this.suspendedTurn = null;
        this.autoApprove = config.auto_approve ?? true;
        this.sessionId = crypto.randomUUID();
        this.abortController = null;

        // Event callbacks (set by chat-ui.js)
        this.onThinkingStart = () => { };
        this.onThinkingEnd = () => { };
        this.onReasoning = () => { };
        this.onToolProposal = async () => ({ approved: true }); // auto-approve by default
        this.onToolExecuting = () => { };
        this.onToolResults = () => { };
        this.onResponse = () => { };
        this.onError = () => { };
        this.onRetry = () => { };
        this.onCheckpoint = () => { };
    }

    /**
     * Set the system prompt (called after catalog is built).
     */
    setSystemPrompt(prompt) {
        this.systemPrompt = prompt;
    }

    /**
     * Set the active model.
     */
    setModel(modelValue) {
        this.selectedModel = modelValue;
        // Clear any per-conversation reasoning override so the newly-selected
        // model resolves from its own configured default.
        this.reasoningOverride = null;
    }

    /**
     * Get the config for the currently selected model.
     */
    getModelConfig() {
        const found = this.config.llm_models?.find(m => m.value === this.selectedModel);
        return found || this.config.llm_models?.[0] || {
            value: this.selectedModel,
            endpoint: 'https://llm-proxy.nrp-nautilus.io/v1',
            api_key: 'EMPTY'
        };
    }

    /**
     * The active remote-round checkpoint threshold for the current mode.
     * 0 or null means "no checkpoint" for that mode.
     */
    activeThreshold() {
        return this.autoApprove ? this.maxToolCalls : this.maxToolCallsManual;
    }

    /**
     * Abort the in-flight turn, if any. Cancels the current LLM fetch
     * and causes the agent loop to bail out at its next await point.
     */
    abort() {
        this.abortController?.abort();
    }

    /**
     * Process a user message through the full agentic loop.
     *
     * Voice input is handled upstream in chat-ui.js via the Transcriber
     * module, so this method always receives plain text regardless of how
     * the user entered their message.
     *
     * @param {string} userMessage
     * @returns {Promise<{response: string, sqlQueries: string[], cancelled: boolean}>}
     */
    async processMessage(userMessage) {
        // Track SQL queries for this turn. When resuming a suspended turn, carry
        // forward the queries already collected before the pause.
        const resuming = this.suspendedTurn;
        const sqlQueries = resuming ? resuming.sqlQueries : [];

        // Per-turn AbortController — triggered by abort() (user-pressed Stop)
        // or by the 5-min timeout inside callLLM(). Either path rejects any
        // outstanding await via the abortPromise race below.
        this.abortController = new AbortController();
        const signal = this.abortController.signal;
        const abortPromise = new Promise((_, reject) => {
            signal.addEventListener('abort', () => {
                reject(new DOMException('Aborted', 'AbortError'));
            });
        });
        // Silence "unhandled rejection" if abort fires while no withAbort() race is active
        // (e.g. user stops during the LLM fetch, which owns the signal directly).
        abortPromise.catch(() => {});
        const withAbort = (p) => Promise.race([p, abortPromise]);

        this.messages.push({ role: 'user', content: userMessage });

        let turnMessages;
        if (resuming) {
            // Resume the paused turn: reuse its full tool-call history and append
            // the new user message (a canned "continue" or a steering instruction).
            // Do NOT rebuild from this.messages — that would discard the in-flight
            // work and restart from scratch.
            this.suspendedTurn = null;
            turnMessages = resuming.turnMessages;
            turnMessages.push({ role: 'user', content: userMessage });
        } else {
            turnMessages = [
                { role: 'system', content: this.systemPrompt },
                ...this.messages.slice(-12),
            ];
        }

        const tools = this.toolRegistry.getToolsForLLM();
        const modelConfig = this.getModelConfig();
        let endpoint = modelConfig.endpoint;
        if (!endpoint.endsWith('/chat/completions')) {
            endpoint = endpoint.replace(/\/$/, '') + '/chat/completions';
        }

        let iterations = 0;
        // Consecutive local-only tool rounds. Local map tools never increment
        // `iterations` (they're cheap and never gated), so a model stuck
        // re-issuing a local tool — e.g. set_filter failing — would loop forever
        // with no checkpoint to stop it (#243). This counter bounds that.
        let localOnlyStreak = 0;
        // Malformed-tool-call recovery attempts this turn (#288). When the model
        // emits something that *looks* like a tool call but we can't parse it, we
        // re-prompt it to re-emit a well-formed call instead of silently treating
        // the garbage as a final answer. Bounded so a model that simply cannot
        // produce a parseable call falls through to its text rather than looping.
        let parseRetries = 0;
        const MAX_PARSE_RETRIES = 2;

        try {
        while (true) {
            const threshold = this.activeThreshold();
            if (threshold && iterations >= threshold) {
                return await this._checkpoint(endpoint, modelConfig, turnMessages, sqlQueries, iterations);
            }
            // Runaway guard: a turn that does `threshold` local-only rounds in a row
            // (with no remote round and no final answer) is stuck looping, not making
            // progress. Checkpoint it like any other cap. A remote round resets the
            // streak, so legitimately tool-heavy turns are unaffected.
            if (threshold && localOnlyStreak >= threshold) {
                return await this._checkpoint(endpoint, modelConfig, turnMessages, sqlQueries, iterations);
            }
            this.onThinkingStart();

            // Call LLM — no withAbort wrapper: the shared AbortController's
            // signal already reaches fetch, and wrapping would orphan the
            // fetch's own AbortError rejection.
            let message;
            try {
                message = await this.callLLM(endpoint, modelConfig, turnMessages, tools);
            } finally {
                this.onThinkingEnd();
            }
            // Surface reasoning before pushing back into the loop. Strips
            // <think> blocks from content and drops reasoning_content from
            // the message so it isn't re-sent on subsequent turns.
            const reasoning = this.extractReasoning(message);
            if (reasoning) this.onReasoning(reasoning, iterations);
            // Canonicalize native tool-call arguments before they enter history
            // (#288, failure mode 2): a malformed `arguments` string (e.g. an
            // extra trailing brace) is parseable-for-execution below but, left
            // verbatim in the assistant message, poisons the *next* upstream
            // request (400 Extra data). Normalize once here so history is always
            // valid JSON regardless of what the model emitted.
            this.normalizeToolCallArguments(message);
            turnMessages.push(message);

            // Check for tool calls
            const toolCalls = message.tool_calls || [];
            const embeddedCalls = toolCalls.length === 0 ? this.parseEmbeddedToolCalls(message.content) : [];

            if (toolCalls.length > 0 || embeddedCalls.length > 0) {
                // A parseable call ends any malformed-call streak — a single glitch
                // over a long turn shouldn't accumulate toward the recovery cap.
                parseRetries = 0;
                const calls = toolCalls.length > 0 ? toolCalls : this.syntheticToolCalls(embeddedCalls);

                // Classify: are all calls local (auto-approve) or mixed?
                const allLocal = calls.every(tc => this.toolRegistry.isLocal(tc.function.name));

                // Only remote (MCP/SQL) rounds count toward the checkpoint
                // threshold — local map tools are cheap and never gated. But a
                // remote round breaks a local-only streak, while a local-only
                // round extends it (the runaway guard above).
                if (!allLocal) {
                    iterations++;
                    localOnlyStreak = 0;
                } else {
                    localOnlyStreak++;
                }

                // Strip recovered tool-call text from content before displaying to user
                const displayContent = message.content
                    ? this.stripEmbeddedCalls(message.content)
                    : null;

                let approved = true;
                if (!allLocal && !this.autoApprove) {
                    // Show proposal and wait for approval
                    const result = await withAbort(this.onToolProposal(calls, displayContent, iterations));
                    approved = result.approved;
                } else {
                    // Auto-approve: local tools always, remote tools when autoApprove is on
                    this.onToolProposal(calls, displayContent, iterations, true /* autoApproved */);
                }

                if (!approved) {
                    return { response: null, sqlQueries, cancelled: true };
                }

                // Signal that tools are now executing
                this.onToolExecuting(calls);

                // Execute all tool calls
                const results = [];
                for (const tc of calls) {
                    let args;
                    try {
                        args = typeof tc.function.arguments === 'string'
                            ? JSON.parse(tc.function.arguments)
                            : tc.function.arguments;
                    } catch {
                        const err = 'Error: Invalid JSON in tool arguments';
                        turnMessages.push({ role: 'tool', tool_call_id: tc.id, content: err });
                        results.push({ name: tc.function.name, result: err, source: 'error' });
                        continue;
                    }

                    const execResult = await withAbort(this.toolRegistry.execute(tc.function.name, args));
                    results.push(execResult);

                    // Track SQL queries
                    if (execResult.sqlQuery) sqlQueries.push(execResult.sqlQuery);

                    // Add to conversation — cap to prevent SQL results from consuming
                    // the remaining context budget mid-turn. 16K fits current STAC
                    // schema-discovery payloads (~8–10 KB at largest) with headroom.
                    const TOOL_RESULT_CAP = 16000;
                    const resultContent = execResult.result?.length > TOOL_RESULT_CAP
                        ? execResult.result.substring(0, TOOL_RESULT_CAP) + '\n... (truncated)'
                        : execResult.result;
                    turnMessages.push({
                        role: 'tool',
                        tool_call_id: tc.id,
                        content: resultContent,
                    });
                }

                // Show results
                this.onToolResults(results, iterations);

                // Continue loop — LLM will see the results
                continue;
            }

            const content = message.content || '';

            // Malformed tool-call recovery (#288, failure modes 1 & 3): we got
            // neither structured tool_calls nor a parseable embedded call, yet the
            // content looks like the model *tried* to call a tool (wrong wrapper,
            // mismatched close tag, or invalid inner JSON). Rather than silently
            // returning the garbage as the final answer, nudge it to re-emit a
            // well-formed call and continue the loop. Bounded by MAX_PARSE_RETRIES
            // so a model that can't recover degrades to its text instead of looping.
            if (parseRetries < MAX_PARSE_RETRIES && this.looksLikeAttemptedToolCall(content)) {
                parseRetries++;
                turnMessages.push({
                    role: 'user',
                    content: 'That looked like a tool call but could not be parsed. Re-emit it as a single '
                        + 'well-formed call: <tool_call>{"name": "<tool_name>", "arguments": {…}}</tool_call> '
                        + 'with valid JSON and a matching </tool_call> tag. If you already have your answer, '
                        + 'reply in plain text instead.',
                });
                continue;
            }

            // No tool calls — final response
            if (!content.trim()) {
                return {
                    response: 'I received your question but had trouble generating a response. Please try rephrasing.',
                    sqlQueries,
                    cancelled: false
                };
            }

            // Store in conversation history
            this.messages.push({ role: 'assistant', content });
            this.suspendedTurn = null;

            return { response: content, sqlQueries, cancelled: false };
        }
        } catch (err) {
            if (err.name === 'AbortError') {
                return { response: null, sqlQueries, cancelled: true };
            }
            throw err;
        }
    }

    /**
     * Pause the turn at a checkpoint: make one no-tools LLM call to produce a
     * human-readable progress report, persist the in-flight turn so the next
     * user message resumes it, and emit onCheckpoint. Returns a result the UI
     * renders as a checkpoint (summary + Continue), not an error.
     */
    async _checkpoint(endpoint, modelConfig, turnMessages, sqlQueries, iterations) {
        const fallbackSummary = `I've run ${iterations} data queries so far and paused to check in. `
            + `Let me know if you'd like me to continue.`;

        turnMessages.push({
            role: 'user',
            content: `You have reached a checkpoint after ${iterations} data ${iterations === 1 ? 'query' : 'queries'}. `
                + `Summarize for the user what you have done so far, the key findings, and what remains to be done. `
                + `Then offer to continue.`,
        });

        let summary = '';
        try {
            const msg = await this.callLLM(endpoint, modelConfig, turnMessages, [] /* no tools → tool_choice none */);
            summary = (msg.content || '').trim();
            turnMessages.push(msg);
        } catch (err) {
            if (err.name === 'AbortError') {
                // User stopped during the summary call. The completed tool work
                // is still valuable — preserve it (minus the checkpoint
                // instruction we just appended) so "continue" resumes the
                // investigation rather than discarding the remote rounds.
                turnMessages.pop();
                this.suspendedTurn = { turnMessages, sqlQueries };
                return { response: null, sqlQueries, cancelled: true };
            }
            summary = fallbackSummary;
        }
        if (!summary) {
            summary = fallbackSummary;
        }

        // Persist the live turn so the next message resumes it instead of
        // rebuilding from scratch. Record the summary in cross-turn history.
        this.suspendedTurn = { turnMessages, sqlQueries };
        this.messages.push({ role: 'assistant', content: summary });

        this.onCheckpoint(summary, iterations);
        return { response: summary, sqlQueries, checkpoint: true, cancelled: false };
    }

    /**
     * Resolve sampling params (temperature, top_p, seed) for the outgoing
     * chat-completion payload. Each is read per-model first, then falls back
     * to a global config default. Per-model `null` opts back out of a value
     * (omits the key) even when a global default exists.
     *
     * `temperature` additionally defaults to 0 when nothing is configured:
     * factual/analyst use is the common case, and geo-agent talks to many
     * OpenAI-compatible endpoints (NRP proxy, OpenRouter, user-supplied keys)
     * whose own defaults vary (0.7 and up) — so we pin a reproducible value
     * client-side rather than inheriting whatever the endpoint happens to use.
     * `top_p`/`seed` have no sensible universal default, so they stay omitted.
     */
    _samplingParams(modelConfig) {
        const defaults = { temperature: 0 };
        const params = {};
        for (const key of ['temperature', 'top_p', 'seed']) {
            // Per-model wins; `null` there is an explicit opt-out (skip the key).
            // Otherwise fall back to global config, then to the built-in default.
            const value = key in (modelConfig ?? {})
                ? modelConfig[key]
                : this.config[key] ?? defaults[key];
            if (value !== undefined && value !== null) params[key] = value;
        }
        return params;
    }

    /**
     * Whether the reasoning on/off toggle should be *offered* for a model.
     * Capability is opt-in per deployment: `reasoning_toggle: true` per-model,
     * else the top-level global. Off (absent) by default — most models/apps
     * don't expose it. Consumed by chat-ui.js to decide whether to render the
     * toggle. Resolved per-model first, then global (mirrors `_samplingParams`).
     */
    _reasoningCapable(modelConfig) {
        const v = ('reasoning_toggle' in (modelConfig ?? {}))
            ? modelConfig.reasoning_toggle
            : this.config?.reasoning_toggle;
        return v === true;
    }

    /**
     * The configured default reasoning state (per-model first, then global).
     * Returns a boolean when set, or `undefined` when unconfigured — in which
     * case we emit nothing and let the model/proxy use its own default.
     */
    _reasoningDefault(modelConfig) {
        const v = ('reasoning_default' in (modelConfig ?? {}))
            ? modelConfig.reasoning_default
            : this.config?.reasoning_default;
        return typeof v === 'boolean' ? v : undefined;
    }

    /**
     * Resolve the thinking-control payload for a turn. Emits `enable_thinking`
     * (a normalized flag the open-llm-proxy maps to the correct per-backend
     * chat-template knob) only when this model participates — i.e. the deployer
     * enabled the toggle or set a default. Otherwise the key is omitted so the
     * model's own default is untouched (no behavior change by default).
     *
     * Value precedence: per-conversation user override (the UI toggle) wins,
     * then the configured default, then — for a toggle-capable model — `true`.
     * This mirrors chat-ui's `reasoningState()` exactly, so what the 🧠 toggle
     * shows and what we send can never disagree. See #283.
     */
    _thinkingParams(modelConfig) {
        const capable = this._reasoningCapable(modelConfig);
        const dflt = this._reasoningDefault(modelConfig);
        // Untouched unless the deployer opted this model in somehow.
        if (!capable && dflt === undefined) return {};
        let value;
        if (typeof this.reasoningOverride === 'boolean') value = this.reasoningOverride;
        else if (typeof dflt === 'boolean') value = dflt;
        else value = capable ? true : undefined; // toggle shown → defaults on
        return typeof value === 'boolean' ? { enable_thinking: value } : {};
    }

    /**
     * Whether to attach Anthropic-style `cache_control` breakpoints to the
     * outgoing prompt for this model (#273). Off by default — resolved per-model
     * first, then global (mirrors `_samplingParams`/`_thinkingParams`).
     *
     * This is a **Claude-specific** lever and should be enabled per-model on
     * Anthropic-routed entries only. Two reasons it's opt-in, not fleet-wide:
     *   1. Anthropic caching is opt-in — you get *nothing* without cache_control,
     *      so this is the only way Claude turns benefit. Open backends (NRP vLLM,
     *      some OpenRouter providers) already do automatic prefix caching for
     *      free, so the breakpoints buy them nothing.
     *   2. Enabling it reshapes the system message from a plain string into the
     *      content-parts array form (below) so the breakpoint has a block to ride
     *      on. That reshape — not the ignored `cache_control` key — is the only
     *      cross-backend compatibility surface; keeping it per-model avoids
     *      changing payload shape for models that gain nothing.
     * The open-llm-proxy forwards the `messages` array verbatim, so a
     * message-embedded breakpoint reaches the provider (unlike top-level cache
     * params, which the proxy drops). See #273.
     */
    _promptCacheEnabled(modelConfig) {
        const v = ('prompt_cache' in (modelConfig ?? {}))
            ? modelConfig.prompt_cache
            : this.config?.prompt_cache;
        return v === true;
    }

    /**
     * Return a copy of `messages` with a `cache_control` breakpoint on the
     * system prompt when prompt caching is enabled for this model, else the
     * array unchanged (byte-identical to today — the default path).
     *
     * The breakpoint goes on the system message because it carries the big,
     * every-call-identical prefix (base prompt + injected dataset catalog,
     * ~34k tokens per #294). On the Anthropic side the render order is
     * tools → system → messages, so a breakpoint on the last system block
     * caches the tool definitions too. Only string-content system messages are
     * reshaped; anything already in content-parts form is passed through.
     */
    _applyPromptCache(messages, modelConfig) {
        if (!this._promptCacheEnabled(modelConfig)) return messages;
        return messages.map(m =>
            m.role === 'system' && typeof m.content === 'string'
                ? { ...m, content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }] }
                : m
        );
    }

    /**
     * Resolve the per-attempt LLM timeout in milliseconds. Mirrors
     * `_samplingParams` resolution: per-model `llm_timeout_seconds` wins, then
     * global config, then a built-in default.
     *
     * Default is 600s to match the upstream llm-proxy's own timeout — a
     * shorter client cutoff (the old 300s) aborts responses the proxy would
     * still deliver, which made slow-decode models (e.g. glm-5.2, or anything
     * on the gb10) unusable. Slow reasoning models legitimately spend minutes
     * decoding; the client must not be the premature limiter. Raise per-model
     * (or globally) when the whole chain is configured to run longer.
     */
    _llmTimeoutMs(modelConfig) {
        const s = ('llm_timeout_seconds' in (modelConfig ?? {}))
            ? modelConfig.llm_timeout_seconds
            : this.config?.llm_timeout_seconds;
        return Number.isFinite(s) && s > 0 ? s * 1000 : 600000;
    }

    /**
     * Whether the endpoint is a trusted proxy host that should receive the
     * `X-Client` attribution header (#254). Gated because geo-agent runs in the
     * browser: a custom request header extends the CORS preflight, and a
     * bring-your-own endpoint whose `Access-Control-Allow-Headers` doesn't list
     * `X-Client` would have the browser block *every* request to it. Our proxy
     * allowlists it (and only our logs use it), so send it only there.
     *
     * Default allowlist is `nrp-nautilus.io` (our infra — the same origin the
     * proxy's own CORS regex trusts); override per deployment with
     * `client_header_hosts` (array of host suffixes).
     */
    _isTrustedProxyHost(endpoint) {
        let host;
        try { host = new URL(endpoint).hostname; } catch { return false; }
        const suffixes = this.config?.client_header_hosts ?? ['nrp-nautilus.io'];
        return suffixes.some(s => host === s || host.endsWith('.' + s));
    }

    /**
     * The `X-Client` header for log attribution, or `{}` when the endpoint isn't
     * a trusted proxy host (spread into the fetch headers). See #254.
     */
    _clientHeaders(endpoint) {
        return this._isTrustedProxyHost(endpoint)
            ? { 'X-Client': `geo-agent/${APP_VERSION}` }
            : {};
    }

    /**
     * Call the LLM API, with one auto-retry on transient errors (gateway 5xx,
     * network blips, client-side timeout).
     *
     * Retry timeout depends on the failure: a *timeout* means the model is
     * slow, not dead, so the retry gets the full budget again (a short retry
     * window a slow model is guaranteed to blow through just wastes a round).
     * A fast transient failure (5xx / network blip) keeps a tight 90s retry so
     * a genuinely-dead endpoint fails fast instead of burning the full budget.
     */
    async callLLM(endpoint, modelConfig, messages, tools) {
        const payload = {
            model: this.selectedModel,
            messages: this._applyPromptCache(messages, modelConfig),
            tools: tools.length > 0 ? tools : undefined,
            tool_choice: tools.length > 0 ? 'auto' : 'none',
            user: this.sessionId,
            ...this._samplingParams(modelConfig),
            ...this._thinkingParams(modelConfig),
        };

        const timeoutMs = this._llmTimeoutMs(modelConfig);
        try {
            return await this._attemptLLMCall(endpoint, modelConfig, payload, timeoutMs);
        } catch (error) {
            if (!this._isTransientLLMError(error)) throw error;
            if (this.abortController?.signal.aborted) throw error; // user-Stop, don't retry

            const retryMs = error.timedOut ? timeoutMs : 90000;
            console.warn(`[Agent] Transient LLM error, retrying with ${Math.round(retryMs / 1000)}s timeout:`, error.message);
            this.onRetry?.(error);

            return await this._attemptLLMCall(endpoint, modelConfig, payload, retryMs);
        }
    }

    /**
     * Single attempt of the LLM fetch. Uses a per-attempt internal AbortController
     * so the timeout doesn't disturb the turn-level abortController (which the
     * outer loop's withAbort race depends on). User-pressed Stop is forwarded
     * from this.abortController to the internal controller.
     */
    async _attemptLLMCall(endpoint, modelConfig, payload, timeoutMs) {
        const internal = new AbortController();
        let timedOut = false;

        const userSignal = this.abortController?.signal;
        const forwardAbort = () => internal.abort();
        if (userSignal) {
            if (userSignal.aborted) internal.abort();
            else userSignal.addEventListener('abort', forwardAbort, { once: true });
        }

        const timeout = setTimeout(() => {
            timedOut = true;
            internal.abort();
        }, timeoutMs);

        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${modelConfig.api_key}`,
                    ...this._clientHeaders(endpoint),
                },
                body: JSON.stringify(payload),
                signal: internal.signal,
            });

            if (!response.ok) {
                const errorText = await response.text();
                const err = new Error(`LLM API error (${response.status}): ${errorText.substring(0, 200)}`);
                err.status = response.status;
                throw err;
            }

            const data = await response.json();
            return data.choices[0].message;
        } catch (error) {
            if (error.name === 'AbortError') {
                if (timedOut) {
                    const err = new Error(`Request timed out after ${Math.round(timeoutMs / 1000)} seconds`);
                    err.timedOut = true;
                    throw err;
                }
                throw error; // user-pressed Stop — let AbortError propagate
            }
            throw error;
        } finally {
            clearTimeout(timeout);
            userSignal?.removeEventListener('abort', forwardAbort);
        }
    }

    /**
     * Classify an LLM error as transient (worth retrying) or permanent.
     * Retry on: client timeout, network errors, HTTP 5xx.
     * Skip on: user-pressed Stop (real AbortError), HTTP 4xx, anything else.
     */
    _isTransientLLMError(error) {
        if (error.name === 'AbortError') return false;
        if (error.timedOut) return true;
        if (error.name === 'TypeError') return true;
        if (typeof error.status === 'number' && error.status >= 500 && error.status < 600) return true;
        return false;
    }

    /**
     * Extract reasoning from a model message (mutates: strips reasoning_content
     * and inline <think> blocks so they don't get re-sent on the next turn).
     * Returns the combined reasoning text, or null if none was present.
     *
     * Handles two shapes:
     *   1. `reasoning_content` field (vLLM/qwen3/DeepSeek thinking-mode template)
     *   2. Inline <think>...</think> blocks in `content` (qwen3 default, others)
     */
    extractReasoning(message) {
        const parts = [];

        if (typeof message.reasoning_content === 'string' && message.reasoning_content.trim()) {
            parts.push(message.reasoning_content.trim());
        }
        delete message.reasoning_content;

        if (typeof message.content === 'string' && message.content.includes('<think>')) {
            const pattern = /<think>([\s\S]*?)<\/think>/gi;
            let m;
            while ((m = pattern.exec(message.content)) !== null) {
                const text = m[1].trim();
                if (text) parts.push(text);
            }
            message.content = message.content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        }

        return parts.length > 0 ? parts.join('\n\n') : null;
    }

    /**
     * Parse embedded tool calls from message content (#288, #295).
     *
     * Upstream hosts that stop emitting structured `tool_calls` fall back to a
     * grab-bag of content dialects — we must be tolerant of all of them or the
     * raw call leaks to the user as the final answer. Handled here:
     *   - Wrappers: <tool_call>… (GLM-style) *and* <tool_code>… (Gemini-style),
     *     with a missing / mismatched closing tag (#288, failure mode 1).
     *   - Bare, unwrapped JSON tool-call objects, singly or concatenated (#295).
     *   - Body shapes: flat {"name","arguments"} *and* nested OpenAI
     *     {"type":"function","function":{"name","arguments"}} (#295).
     *   - `parameters` as an alias for `arguments` (#295).
     */
    parseEmbeddedToolCalls(content) {
        if (!content) return [];
        const calls = [];

        // Wrapped calls: capture from a <tool_call>/<tool_code> open tag up to the
        // *first* of a closing tag (</… — including a mismatched </parameter>), a new
        // wrapper, or EOF, instead of requiring an exact close with no interior '<'.
        // The lookahead leaves the terminator unconsumed; each match still consumes
        // the literal open tag, so lastIndex always advances.
        const pattern = /<tool_c(?:all|ode)>\s*([\s\S]*?)\s*(?=<\/|<tool_c(?:all|ode)>|$)/gi;
        let match;
        let sawWrapper = false;
        while ((match = pattern.exec(content)) !== null) {
            sawWrapper = true;
            const inner = match[1].trim();
            if (inner) this._pushEmbeddedCall(inner, calls);
        }

        // Bare (unwrapped) tool-call JSON — only when no wrapper was seen, to avoid
        // double-extracting and to keep the scan off ordinary prose. `_normalizeCall`
        // is signature-gated, so a final answer that merely contains JSON (e.g. a
        // style blob) is not misread as a call.
        if (!sawWrapper) {
            for (const { value } of this._scanJSONObjects(content)) {
                const call = this._normalizeCall(value);
                if (call) calls.push(call);
            }
        }

        return calls;
    }

    /**
     * Remove recovered tool-call text from content before it is shown to the user
     * (#295). Strips both wrappers (closed, or unclosed to EOF), then excises any
     * bare tool-call JSON objects the parser would have recognized. Spans are
     * removed back-to-front so earlier indices stay valid.
     */
    stripEmbeddedCalls(content) {
        if (!content) return content;
        let out = content
            .replace(/<tool_c(?:all|ode)>[\s\S]*?<\/tool_c(?:all|ode)>/gi, '')
            .replace(/<tool_c(?:all|ode)>[\s\S]*$/gi, '');
        const spans = this._scanJSONObjects(out).filter(o => this._normalizeCall(o.value));
        for (let i = spans.length - 1; i >= 0; i--) {
            out = out.slice(0, spans[i].start) + out.slice(spans[i].end + 1);
        }
        return out.trim();
    }

    /**
     * Extract one or more calls from a single wrapper's inner blob (#295). Tries
     * JSON objects first (one or several concatenated), then the non-JSON shapes.
     */
    _pushEmbeddedCall(inner, calls) {
        // JSON object(s): flat or nested, lenient (a trailing extra brace still parses).
        let found = false;
        for (const { value } of this._scanJSONObjects(inner)) {
            const call = this._normalizeCall(value);
            if (call) { calls.push(call); found = true; }
        }
        if (found) return;

        // Function-call shape: tool_name({"arg": "val"})
        const funcMatch = inner.match(/^(\w+)\s*\(([\s\S]+)\)$/);
        if (funcMatch) {
            const args = this.parseLenientJSON(funcMatch[2]);
            if (args !== undefined) { calls.push({ name: funcMatch[1], args }); return; }
        }

        // Hermes/pythonic `<function=NAME>…` dialect (#295), incl. the corrupted
        // `<function=query", "arguments": {…}` form observed live on qwen/nimbus —
        // the sole failure mode still leaking under the #288 net. Take the name
        // from the tag, then the first JSON object after it as args, unwrapping a
        // lone {"arguments"|"parameters": {…}} envelope.
        const fnTag = inner.match(/<function=(\w+)/);
        if (fnTag) {
            const rest = inner.slice(fnTag.index + fnTag[0].length);
            const objs = this._scanJSONObjects(rest);
            let args = objs.length ? objs[0].value : {};
            if (args && typeof args === 'object' && !Array.isArray(args)) {
                const keys = Object.keys(args);
                if (keys.length === 1 && (keys[0] === 'arguments' || keys[0] === 'parameters')
                    && args[keys[0]] && typeof args[keys[0]] === 'object') {
                    args = args[keys[0]];
                }
            } else {
                args = {};
            }
            calls.push({ name: fnTag[1], args });
            return;
        }

        // Lone quoted name against a known tool: {"list_datasets"}
        const bareName = inner.match(/^\{\s*"(\w+)"\s*\}$/);
        if (bareName && this.toolRegistry.has(bareName[1])) {
            calls.push({ name: bareName[1], args: {} });
            return;
        }

        // Simple name
        if (/^\w+$/.test(inner) && this.toolRegistry.has(inner)) {
            calls.push({ name: inner, args: {} });
        }
    }

    /**
     * Normalize a parsed JSON value into {name, args} if it is a tool call, else
     * null (#295). Accepts both the flat shape and the nested OpenAI
     * {"type":"function","function":{…}} shape, and `parameters` as an alias for
     * `arguments`. Signature-gated for the bare-JSON path: a flat object with no
     * args key and an unregistered name is rejected so stray JSON in a final answer
     * is not swallowed as a call.
     */
    _normalizeCall(parsed) {
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        const nested = parsed.type === 'function'
            && parsed.function && typeof parsed.function === 'object';
        const fn = nested ? parsed.function : parsed;
        const name = fn.name;
        if (typeof name !== 'string' || !name) return null;
        const hasArgsKey = ('arguments' in fn) || ('parameters' in fn);
        if (!nested && !hasArgsKey && !this.toolRegistry.has(name)) return null;
        let args = fn.arguments ?? fn.parameters ?? {};
        if (typeof args === 'string') args = this.parseLenientJSON(args) ?? {};
        if (!args || typeof args !== 'object') args = {};
        return { name, args };
    }

    /**
     * Parse a JSON value leniently (#288, failure mode 2/3). Tries a strict parse
     * first; on failure, falls back to a raw_decode-style scan that returns the
     * first complete, balanced JSON object/array and ignores any trailing junk —
     * recovering the common `{"k": "v"}}` extra-brace case. Returns the parsed
     * value, or `undefined` if nothing valid could be extracted.
     */
    parseLenientJSON(str) {
        if (typeof str !== 'string') return undefined;
        const s = str.trim();
        if (!s) return undefined;
        try {
            return JSON.parse(s);
        } catch { /* fall through to raw_decode */ }
        return this._decodeFirstJSON(s);
    }

    /**
     * raw_decode helper: scan from the first '{' or '[' and return the first
     * balanced, valid JSON value, respecting strings and escapes. Trailing text
     * after the balanced value is ignored. Returns `undefined` on no match.
     */
    _decodeFirstJSON(s) {
        const start = s.search(/[{[]/);
        if (start === -1) return undefined;
        const end = this._matchBalanced(s, start);
        if (end === -1) return undefined;
        try {
            return JSON.parse(s.slice(start, end + 1));
        } catch {
            return undefined;
        }
    }

    /**
     * Index of the closer that balances the opening bracket at `start`, or -1 if
     * none. Respects strings and escapes so a bracket inside a string literal is
     * not mistaken for structure. Shared by _decodeFirstJSON and _scanJSONObjects.
     */
    _matchBalanced(s, start) {
        const open = s[start];
        const close = open === '{' ? '}' : open === '[' ? ']' : null;
        if (!close) return -1;
        let depth = 0, inStr = false, esc = false;
        for (let i = start; i < s.length; i++) {
            const c = s[i];
            if (inStr) {
                if (esc) esc = false;
                else if (c === '\\') esc = true;
                else if (c === '"') inStr = false;
                continue;
            }
            if (c === '"') { inStr = true; continue; }
            if (c === open) depth++;
            else if (c === close && --depth === 0) return i;
        }
        return -1;
    }

    /**
     * Scan a string for all top-level balanced JSON objects/arrays and return the
     * valid ones as {value, start, end} (end inclusive). Handles several calls
     * concatenated in one blob (#295) and, because it carries positions, lets the
     * display stripper excise recovered bare calls. Invalid/unbalanced regions and
     * non-JSON prose between objects are skipped.
     */
    _scanJSONObjects(s) {
        const results = [];
        if (typeof s !== 'string') return results;
        let i = 0;
        while (i < s.length) {
            const rel = s.slice(i).search(/[{[]/);
            if (rel === -1) break;
            const start = i + rel;
            const end = this._matchBalanced(s, start);
            if (end === -1) { i = start + 1; continue; }
            try {
                results.push({ value: JSON.parse(s.slice(start, end + 1)), start, end });
            } catch { /* skip this region */ }
            i = end + 1;
        }
        return results;
    }

    /**
     * Canonicalize a message's native tool-call `arguments` to valid JSON strings
     * (#288, failure mode 2). A malformed `arguments` string left verbatim in the
     * assistant message poisons the next upstream request. We parse leniently and
     * re-serialize; anything unrecoverable becomes `{}` so history stays valid.
     * Mutates the message in place.
     */
    normalizeToolCallArguments(message) {
        if (!Array.isArray(message?.tool_calls)) return;
        for (const tc of message.tool_calls) {
            if (!tc.function) continue;
            const raw = tc.function.arguments;
            if (typeof raw !== 'string') {
                // Some backends hand back an object — canonicalize to a string.
                tc.function.arguments = JSON.stringify(raw ?? {});
                continue;
            }
            const parsed = this.parseLenientJSON(raw);
            tc.function.arguments = JSON.stringify(parsed ?? {});
        }
    }

    /**
     * Heuristic (#288): does this content look like an *attempted* tool call that
     * we failed to parse? Kept tight to avoid re-prompting genuine final answers.
     */
    looksLikeAttemptedToolCall(content) {
        if (!content) return false;
        if (/<tool_c(?:all|ode)/i.test(content)) return true;
        if (/"(?:name|function|parameters|arguments)"\s*:/.test(content)) return true;
        // Non-JSON XML-ish tool-call markers no genuine prose emits (#297): the
        // corrupted `<function=NAME>` tag, mangled `<parameter=…>` / `<parameter …>`,
        // and Claude's `<invoke …>` / `<model_calls>` fn-call XML.
        if (/<function=|<parameter[=\s]|<invoke\b|<model_calls>/i.test(content)) return true;
        // Bare call or tool-name-as-tag against a *known* tool — gated on the
        // registry so prose that merely names a tool doesn't trip a re-prompt (#297).
        // Covers the whole leaking tail so the #288 recovery at least fires:
        //   show_layer(layer_id="…")   and   <show_layer>{…}</show_layer>
        // Scan *all* matches, not just the first — the real tool tag is often
        // preceded by hallucinated reasoning tags (<antThinking>, </think>, …).
        // The `(` must be followed by something call-shaped — a quote, `{`/`[`, or
        // a `kwarg=` — so a common tool word in prose ("the query (SQL) returned …",
        // "set_filter (applied earlier)") is not misread as an attempted call.
        for (const m of content.matchAll(/\b(\w+)\s*\(\s*(?:["'{[]|[\w-]+\s*=)/g)) {
            if (this.toolRegistry.has(m[1])) return true;
        }
        for (const m of content.matchAll(/<(\w+)[\s>]/g)) {
            if (this.toolRegistry.has(m[1])) return true;
        }
        return false;
    }

    /**
     * Convert parsed embedded calls to synthetic tool_calls format.
     */
    syntheticToolCalls(calls) {
        return calls.map(tc => ({
            id: `emb_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
            type: 'function',
            function: {
                name: tc.name,
                arguments: JSON.stringify(tc.args),
            }
        }));
    }

    /**
     * Clear conversation history. Also drops the registry's idempotent-read
     * memo cache (#281) so a fresh conversation re-fetches metadata rather than
     * serving results cached during the previous one.
     */
    clearHistory() {
        this.messages = [];
        this.toolRegistry?.clearMemo?.();
    }
}
