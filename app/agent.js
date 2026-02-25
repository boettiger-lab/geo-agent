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
        this.maxToolCalls = 20;

        // Event callbacks (set by chat-ui.js)
        this.onThinkingStart = () => { };
        this.onThinkingEnd = () => { };
        this.onToolProposal = async () => ({ approved: true }); // auto-approve by default
        this.onToolResults = () => { };
        this.onResponse = () => { };
        this.onError = () => { };
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
     * Process a user message through the full agentic loop.
     * 
     * @param {string} userMessage
     * @returns {Promise<{response: string, sqlQueries: string[], cancelled: boolean}>}
     */
    async processMessage(userMessage) {
        // Track SQL queries for this turn
        const sqlQueries = [];

        // Add user message to history
        this.messages.push({ role: 'user', content: userMessage });

        // Build conversation for this turn
        const turnMessages = [
            { role: 'system', content: this.systemPrompt },
            ...this.messages.slice(-12), // Keep recent context
        ];

        const tools = this.toolRegistry.getToolsForLLM();
        const modelConfig = this.getModelConfig();
        let endpoint = modelConfig.endpoint;
        if (!endpoint.endsWith('/chat/completions')) {
            endpoint = endpoint.replace(/\/$/, '') + '/chat/completions';
        }

        let iterations = 0;

        while (iterations < this.maxToolCalls) {
            this.onThinkingStart();

            // Call LLM
            const message = await this.callLLM(endpoint, modelConfig, turnMessages, tools);
            turnMessages.push(message);

            this.onThinkingEnd();

            // Check for tool calls
            const toolCalls = message.tool_calls || [];
            const embeddedCalls = toolCalls.length === 0 ? this.parseEmbeddedToolCalls(message.content) : [];

            if (toolCalls.length > 0 || embeddedCalls.length > 0) {
                iterations++;
                const calls = toolCalls.length > 0 ? toolCalls : this.syntheticToolCalls(embeddedCalls);

                // Classify: are all calls local (auto-approve) or mixed?
                const allLocal = calls.every(tc => this.toolRegistry.isLocal(tc.function.name));

                let approved = true;
                if (!allLocal) {
                    // Show proposal and wait for approval
                    const result = await this.onToolProposal(calls, message.content, iterations);
                    approved = result.approved;
                } else {
                    // Auto-approve local tools, but still show what's happening
                    this.onToolProposal(calls, message.content, iterations, true /* autoApproved */);
                }

                if (!approved) {
                    return { response: null, sqlQueries, cancelled: true };
                }

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

                    const execResult = await this.toolRegistry.execute(tc.function.name, args);
                    results.push(execResult);

                    // Track SQL queries
                    if (execResult.sqlQuery) sqlQueries.push(execResult.sqlQuery);

                    // Add to conversation
                    turnMessages.push({
                        role: 'tool',
                        tool_call_id: tc.id,
                        content: execResult.result,
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

            return { response: content, sqlQueries, cancelled: false };
        }

        // Hit max iterations
        return {
            response: `I've reached the maximum number of steps (${this.maxToolCalls}). Please try a more specific question.`,
            sqlQueries,
            cancelled: false
        };
    }

    /**
     * Call the LLM API.
     */
    async callLLM(endpoint, modelConfig, messages, tools) {
        const payload = {
            model: this.selectedModel,
            messages,
            tools: tools.length > 0 ? tools : undefined,
            tool_choice: tools.length > 0 ? 'auto' : undefined,
        };

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 300000); // 5 min

        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${modelConfig.api_key}`,
                },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`LLM API error (${response.status}): ${errorText.substring(0, 200)}`);
            }

            const data = await response.json();
            return data.choices[0].message;
        } catch (error) {
            if (error.name === 'AbortError') throw new Error('Request timed out after 5 minutes');
            throw error;
        } finally {
            clearTimeout(timeout);
        }
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
