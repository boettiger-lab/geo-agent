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
            turnMessages.push(message);

            // Check for tool calls
            const toolCalls = message.tool_calls || [];
            const embeddedCalls = toolCalls.length === 0 ? this.parseEmbeddedToolCalls(message.content) : [];

            if (toolCalls.length > 0 || embeddedCalls.length > 0) {
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

                // Strip embedded <tool_call> tags from content before displaying to user
                const displayContent = message.content
                    ? message.content.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '').trim()
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

            // No tool calls — final response
            const content = message.content || '';
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
     * Call the LLM API, with one auto-retry on transient errors (gateway 5xx,
     * network blips, client-side timeout). The retry uses a tight 90s timeout
     * so a still-dead model fails fast instead of burning another 5 minutes.
     */
    async callLLM(endpoint, modelConfig, messages, tools) {
        const payload = {
            model: this.selectedModel,
            messages,
            tools: tools.length > 0 ? tools : undefined,
            tool_choice: tools.length > 0 ? 'auto' : 'none',
            user: this.sessionId,
        };

        try {
            return await this._attemptLLMCall(endpoint, modelConfig, payload, 300000);
        } catch (error) {
            if (!this._isTransientLLMError(error)) throw error;
            if (this.abortController?.signal.aborted) throw error; // user-Stop, don't retry

            console.warn('[Agent] Transient LLM error, retrying with 90s timeout:', error.message);
            this.onRetry?.(error);

            return await this._attemptLLMCall(endpoint, modelConfig, payload, 90000);
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
     * Parse embedded tool calls from message content.
     * Some models (e.g., GLM-4) emit <tool_call>...</tool_call> tags instead of structured tool_calls.
     */
    parseEmbeddedToolCalls(content) {
        if (!content) return [];
        const calls = [];
        const pattern = /<tool_call>([^<]+)<\/tool_call>/gi;
        let match;

        while ((match = pattern.exec(content)) !== null) {
            const inner = match[1].trim();

            // Try JSON: {"name": "tool", "arguments": {...}}
            try {
                const parsed = JSON.parse(inner);
                if (parsed.name) {
                    calls.push({ name: parsed.name, args: parsed.arguments || {} });
                    continue;
                }
            } catch { /* not JSON */ }

            // Try function call: tool_name({"arg": "val"})
            const funcMatch = inner.match(/^(\w+)\s*\((.+)\)$/s);
            if (funcMatch) {
                try {
                    calls.push({ name: funcMatch[1], args: JSON.parse(funcMatch[2]) });
                    continue;
                } catch { /* bad args */ }
            }

            // Simple name
            if (/^\w+$/.test(inner) && this.toolRegistry.has(inner)) {
                calls.push({ name: inner, args: {} });
            }
        }

        return calls;
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
     * Clear conversation history.
     */
    clearHistory() {
        this.messages = [];
    }
}
