/**
 * ChatUI - Thin UI shell for the chat interface.
 *
 * Owns all DOM manipulation. Consumes events from Agent.
 * Renders collapsible tool-call blocks (VSCode Copilot-inspired).
 */

export class ChatUI {
    /**
     * @param {import('./agent.js').Agent} agent
     * @param {Object} config  - app config (for model list)
     */
    constructor(agent, config) {
        this.agent = agent;
        this.config = config;
        this.busy = false;

        // Cache DOM refs
        this.container = document.getElementById('chat-container');
        this.messagesEl = document.getElementById('chat-messages');
        this.inputEl = document.getElementById('chat-input');
        this.sendBtn = document.getElementById('chat-send');
        this.modelSelector = document.getElementById('model-selector');
        this.toggleBtn = document.getElementById('chat-toggle');

        this.init();
    }

    /* ------------------------------------------------------------------ */
    /*  Initialisation                                                     */
    /* ------------------------------------------------------------------ */

    init() {
        // Wire send button & enter key
        this.sendBtn.addEventListener('click', () => this.handleSend());
        this.inputEl.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.handleSend();
            }
        });

        // Wire collapse toggle
        this.toggleBtn?.addEventListener('click', () => {
            this.container.classList.toggle('collapsed');
        });

        // Populate model selector
        this.populateModelSelector();
        this.modelSelector?.addEventListener('change', () => {
            this.agent.setModel(this.modelSelector.value);
        });

        // If in user-provided API key mode, add settings button
        if (this.config._userProvidedMode) {
            this.initSettingsUI();
            // If no API key saved yet, show the setup prompt
            if (!this.config.llm_models?.length) {
                this.showSettingsPanel();
            }
        }

        // Wire agent callbacks
        this.agent.onThinkingStart = () => this.showThinking();
        this.agent.onThinkingEnd = () => this.hideThinking();
        this.agent.onToolProposal = (calls, text, iter, autoApproved) =>
            this.showToolProposal(calls, text, iter, autoApproved);
        this.agent.onToolResults = (results, iter) => this.showToolResults(results, iter);
        this.agent.onError = (err) => this.addMessage('error', err);
    }

    populateModelSelector() {
        if (!this.modelSelector) return;
        this.modelSelector.innerHTML = '';
        const models = this.config.llm_models || [];
        models.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.value;
            opt.textContent = m.label || m.value;
            this.modelSelector.appendChild(opt);
        });
        if (models.length > 0) {
            this.modelSelector.value = this.agent.selectedModel;
        }
    }

    /* ------------------------------------------------------------------ */
    /*  Settings panel (user-provided API key mode)                         */
    /* ------------------------------------------------------------------ */

    initSettingsUI() {
        const footer = document.getElementById('chat-footer');
        if (!footer) return;

        const btn = document.createElement('button');
        btn.id = 'settings-btn';
        btn.title = 'API settings';
        btn.textContent = '\u2699';
        btn.addEventListener('click', () => this.toggleSettingsPanel());
        footer.prepend(btn);
    }

    toggleSettingsPanel() {
        const existing = document.getElementById('api-settings-panel');
        if (existing) {
            existing.remove();
            return;
        }
        this.showSettingsPanel();
    }

    showSettingsPanel() {
        // Remove any existing panel
        document.getElementById('api-settings-panel')?.remove();

        const llmConfig = this.config.llm || {};
        const savedKey = localStorage.getItem('geo-agent-api-key') || '';
        const savedEndpoint = localStorage.getItem('geo-agent-endpoint')
            || llmConfig.default_endpoint || 'https://openrouter.ai/api/v1';

        const panel = document.createElement('div');
        panel.id = 'api-settings-panel';
        panel.innerHTML = `
            <div class="settings-title">API Settings</div>
            <label class="settings-label" for="settings-endpoint">Endpoint</label>
            <input id="settings-endpoint" type="url" value="${this.escapeHtml(savedEndpoint)}" 
                   placeholder="https://openrouter.ai/api/v1" spellcheck="false">
            <label class="settings-label" for="settings-api-key">API Key</label>
            <input id="settings-api-key" type="password" value="${savedKey ? '••••••••' : ''}" 
                   placeholder="sk-..." spellcheck="false"
                   onfocus="if(this.value.startsWith('••'))this.value=''">
            <div class="settings-actions">
                <button id="settings-save" class="settings-save-btn">Save</button>
                <button id="settings-cancel" class="settings-cancel-btn">Cancel</button>
            </div>
            <div class="settings-hint">
                Keys are stored in your browser only and never sent to this server.
            </div>
        `;

        // Insert before messages area
        this.messagesEl.parentNode.insertBefore(panel, this.messagesEl);

        // Wire buttons
        panel.querySelector('#settings-save').addEventListener('click', () => {
            const endpoint = panel.querySelector('#settings-endpoint').value.trim();
            const apiKey = panel.querySelector('#settings-api-key').value.trim();

            if (!apiKey || apiKey.startsWith('\u2022')) {
                // No change to key if user didn't type a new one
                if (!savedKey) {
                    panel.querySelector('#settings-api-key').style.borderColor = '#dc3545';
                    return;
                }
            } else {
                localStorage.setItem('geo-agent-api-key', apiKey);
            }
            if (endpoint) {
                localStorage.setItem('geo-agent-endpoint', endpoint);
            }

            // Rebuild LLM models from new settings
            this.applyUserLLMConfig();
            panel.remove();
        });

        panel.querySelector('#settings-cancel').addEventListener('click', () => {
            panel.remove();
        });
    }

    /**
     * Rebuild llm_models from localStorage and update the agent.
     */
    applyUserLLMConfig() {
        const llmConfig = this.config.llm || {};
        const apiKey = localStorage.getItem('geo-agent-api-key');
        const endpoint = localStorage.getItem('geo-agent-endpoint')
            || llmConfig.default_endpoint || 'https://openrouter.ai/api/v1';

        if (!apiKey) return;

        const models = (llmConfig.models || []).map(m => ({
            ...m,
            endpoint,
            api_key: apiKey,
        }));

        if (models.length === 0) {
            models.push({ value: 'auto', label: 'Auto', endpoint, api_key: apiKey });
        }

        this.config.llm_models = models;
        this.config.llm_model = models[0]?.value;
        this.agent.config = this.config;
        this.agent.selectedModel = this.config.llm_model;
        this.populateModelSelector();
    }

    /* ------------------------------------------------------------------ */
    /*  Send handler                                                       */
    /* ------------------------------------------------------------------ */

    async handleSend() {
        const text = this.inputEl.value.trim();
        if (!text || this.busy) return;

        // In user-provided mode, check for API key before sending
        if (this.config._userProvidedMode && !localStorage.getItem('geo-agent-api-key')) {
            this.showSettingsPanel();
            return;
        }

        this.busy = true;
        this.sendBtn.disabled = true;
        this.inputEl.value = '';

        // Show user bubble
        this.addMessage('user', text);

        try {
            const { response, cancelled } = await this.agent.processMessage(text);

            if (cancelled) {
                this.addMessage('system', 'Query cancelled.');
            } else if (response) {
                this.addMarkdown('assistant', response);
            }
        } catch (err) {
            console.error('[ChatUI] Error:', err);
            this.addMessage('error', err.message || String(err));
        } finally {
            this.busy = false;
            this.sendBtn.disabled = false;
            this.inputEl.focus();
        }
    }

    /* ------------------------------------------------------------------ */
    /*  Thinking indicator                                                 */
    /* ------------------------------------------------------------------ */

    showThinking() {
        this.removeThinking();
        const el = document.createElement('div');
        el.className = 'chat-message assistant-thinking';
        el.id = 'thinking-indicator';
        el.innerHTML = 'Thinking<span class="loading-dots"></span>';
        this.messagesEl.appendChild(el);
        this.scrollToBottom();
    }

    hideThinking() {
        this.removeThinking();
    }

    removeThinking() {
        document.getElementById('thinking-indicator')?.remove();
    }

    /* ------------------------------------------------------------------ */
    /*  Tool proposal & results (collapsible blocks)                       */
    /* ------------------------------------------------------------------ */

    /**
     * Show a tool proposal — collapsible block listing tool calls.
     * If autoApproved is true, it's just informational.
     * Otherwise returns a promise that resolves with { approved }.
     */
    showToolProposal(calls, reasoningText, iteration, autoApproved = false) {
        this.removeThinking();

        const block = document.createElement('div');
        block.className = 'chat-message tool-block';

        // Build collapsible header
        const names = calls.map(c => c.function.name).join(', ');
        const label = autoApproved ? `⚙️ Running: ${names}` : `🔧 Tool proposal: ${names}`;

        let html = `<details${autoApproved ? '' : ' open'}><summary class="query-summary-btn">${label}</summary><div class="tool-detail">`;

        for (const tc of calls) {
            let args;
            try { args = JSON.parse(tc.function.arguments); } catch { args = tc.function.arguments; }
            const argsStr = typeof args === 'object' ? JSON.stringify(args, null, 2) : String(args);
            html += `<div class="tool-call-item"><strong>${tc.function.name}</strong><pre><code>${this.escapeHtml(argsStr)}</code></pre></div>`;
        }

        html += '</div>';

        if (!autoApproved) {
            html += '<div class="tool-approval-buttons"><button class="approve-btn approve-yes">▶ Run</button><button class="approve-btn approve-no" style="background:#dc3545">✕ Cancel</button></div>';
        }

        html += '</details>';
        block.innerHTML = html;
        this.messagesEl.appendChild(block);
        this.scrollToBottom();

        if (autoApproved) {
            return Promise.resolve({ approved: true });
        }

        // Wait for user to click approve/cancel
        return new Promise(resolve => {
            const yesBtn = block.querySelector('.approve-yes');
            const noBtn = block.querySelector('.approve-no');

            yesBtn.addEventListener('click', () => {
                yesBtn.disabled = true;
                noBtn.disabled = true;
                yesBtn.textContent = '✓ Approved';
                resolve({ approved: true });
            });

            noBtn.addEventListener('click', () => {
                yesBtn.disabled = true;
                noBtn.disabled = true;
                noBtn.textContent = '✕ Cancelled';
                resolve({ approved: false });
            });
        });
    }

    /**
     * Show tool results as a collapsible block.
     */
    showToolResults(results, iteration) {
        const block = document.createElement('div');
        block.className = 'chat-message tool-block';

        const count = results.length;
        const label = `✅ ${count} tool result${count > 1 ? 's' : ''}`;

        let html = `<details><summary class="query-summary-btn">${label}</summary><div class="tool-detail">`;

        for (const r of results) {
            const icon = r.success ? '✓' : '✗';
            const sourceTag = r.source === 'remote' ? ' <span class="tool-tag remote">MCP</span>' : '';
            const truncated = this.truncateResult(r.result, 2000);
            html += `<div class="tool-result-item"><strong>${icon} ${r.name}</strong>${sourceTag}`;

            // If it's a SQL query, show it specially
            if (r.sqlQuery) {
                html += `<details class="sql-detail"><summary>SQL</summary><pre><code class="language-sql">${this.escapeHtml(r.sqlQuery)}</code></pre></details>`;
            }

            html += `<pre class="tool-output"><code>${this.escapeHtml(truncated)}</code></pre></div>`;
        }

        html += '</div></details>';
        block.innerHTML = html;
        this.messagesEl.appendChild(block);
        this.scrollToBottom();

        // Highlight SQL if available
        block.querySelectorAll('code.language-sql').forEach(el => {
            if (typeof hljs !== 'undefined') hljs.highlightElement(el);
        });
    }

    /* ------------------------------------------------------------------ */
    /*  Message rendering                                                  */
    /* ------------------------------------------------------------------ */

    addMessage(role, text) {
        const el = document.createElement('div');
        el.className = `chat-message ${role}`;
        el.textContent = text;
        this.messagesEl.appendChild(el);
        this.scrollToBottom();
    }

    addMarkdown(role, md) {
        const el = document.createElement('div');
        el.className = `chat-message ${role}`;
        el.innerHTML = typeof marked !== 'undefined' ? marked.parse(md) : md;
        this.messagesEl.appendChild(el);

        // Highlight code blocks
        el.querySelectorAll('pre code').forEach(block => {
            if (typeof hljs !== 'undefined') hljs.highlightElement(block);
        });

        this.scrollToBottom();
    }

    /* ------------------------------------------------------------------ */
    /*  Utilities                                                          */
    /* ------------------------------------------------------------------ */

    scrollToBottom() {
        requestAnimationFrame(() => {
            this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
        });
    }

    escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    truncateResult(str, maxLen) {
        if (!str || str.length <= maxLen) return str;
        return str.substring(0, maxLen) + '\n... (truncated)';
    }
}
