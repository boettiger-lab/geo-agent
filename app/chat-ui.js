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
     * @param {Object} mount   - DOM refs from layout-manager.buildLayout()
     *   {
     *     container, messages, input, send, mic, header, footer, footerRight,
     *   }
     */
    constructor(agent, config, mount) {
        this.agent = agent;
        this.config = config;
        this.busy = false;

        // Cache DOM refs from layout-manager (no getElementById here).
        this.container = mount.container;
        this.messagesEl = mount.messages;
        this.inputEl = mount.input;
        this.sendBtn = mount.send;
        this.micBtn = mount.mic;
        this.toggleBtn = mount.container.querySelector('#chat-toggle');  // floating-mode only
        this.headerEl = mount.header;
        this.footerEl = mount.footer;
        this.footerRightEl = mount.footerRight;
        this.modelSelector = mount.footerRight.querySelector('#model-selector');

        // Voice input state. The voice + transcriber modules are loaded
        // lazily via dynamic import() — only when `config.transcription_model`
        // is set. Apps without voice pay zero bytes for audio code.
        this.voice = null;
        this.transcriber = null;
        this.recording = false;

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

        // Voice input (only initialised when a transcription model is
        // configured — otherwise the mic stays hidden and the audio JS
        // modules are never loaded).
        this.initVoiceInput();

        // If in user-provided API key mode, add settings button
        if (this.config._userProvidedMode) {
            this.initSettingsUI();
            // If no API key saved yet, show the setup prompt
            if (!this.config.llm_models?.length) {
                this.showSettingsPanel();
            }
        }

        // Auto-approve toggle (always shown)
        this.initAutoApproveToggle();

        // Optional header/footer links (github, docs, carbon)
        this.initLinks();

        // Wire agent callbacks
        this.agent.onThinkingStart = () => this.showThinking();
        this.agent.onThinkingEnd = () => this.hideThinking();
        this.agent.onToolProposal = (calls, text, iter, autoApproved) =>
            this.showToolProposal(calls, text, iter, autoApproved);
        this.agent.onToolExecuting = (calls) => this.showToolExecuting(calls);
        this.agent.onToolResults = (results, iter) => this.showToolResults(results, iter);
        this.agent.onError = (err) => this.addMessage('error', err);

        // Render welcome message if configured
        this.renderWelcome();
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
    /*  Voice input                                                        */
    /* ------------------------------------------------------------------ */

    /**
     * Initialise voice input if the app config declares a transcription
     * model. Voice + transcriber modules are loaded via dynamic import() so
     * apps without voice pay zero bytes for audio code.
     *
     * Flow: record → stop → transcribe → drop text into the input field →
     * user reviews/edits and presses send. This decouples voice capability
     * from the active agent model: any model can be paired with any
     * transcription backend.
     */
    async initVoiceInput() {
        if (!this.micBtn) return;
        const transcriptionCfg = this.config.transcription_model;
        if (!transcriptionCfg?.value) {
            // No transcription model configured — mic stays hidden, no JS loaded.
            return;
        }

        let VoiceInput, Transcriber;
        try {
            ({ VoiceInput } = await import('./voice-input.js'));
            ({ Transcriber } = await import('./transcriber.js'));
        } catch (err) {
            console.error('[ChatUI] Failed to load voice modules:', err);
            return;
        }

        if (!VoiceInput.isSupported()) {
            // Browser lacks MediaRecorder / getUserMedia — leave mic hidden.
            return;
        }

        this.voice = new VoiceInput();
        this.transcriber = new Transcriber(transcriptionCfg);
        this.micBtn.hidden = false;

        this.micBtn.addEventListener('click', async () => {
            if (this.busy) return;
            if (!this.recording) {
                try {
                    await this.voice.start();
                    this.recording = true;
                    this.micBtn.classList.add('recording');
                    this.micBtn.textContent = '⏹';
                    this.micBtn.title = 'Stop recording';
                } catch (err) {
                    console.error('[ChatUI] Mic start failed:', err);
                    this.addMessage('error', `Microphone error: ${err.message || err}`);
                }
                return;
            }
            // Stop → transcribe → place transcript in the input field.
            try {
                const audio = await this.voice.stop();
                this.recording = false;
                this.micBtn.classList.remove('recording');
                this.micBtn.textContent = '🎤';
                this.micBtn.title = 'Record voice input';

                const prevPlaceholder = this.inputEl.placeholder;
                this.inputEl.placeholder = 'Transcribing…';
                this.inputEl.disabled = true;
                try {
                    const transcript = await this.transcriber.transcribe(audio);
                    // Append to any existing text so users can prefix/suffix.
                    const existing = this.inputEl.value;
                    this.inputEl.value = existing
                        ? `${existing} ${transcript}`.trim()
                        : transcript;
                } finally {
                    this.inputEl.placeholder = prevPlaceholder;
                    this.inputEl.disabled = false;
                    this.inputEl.focus();
                }
            } catch (err) {
                console.error('[ChatUI] Mic stop / transcription failed:', err);
                this.addMessage('error', `Voice input error: ${err.message || err}`);
                this.recording = false;
                this.micBtn.classList.remove('recording');
                this.micBtn.textContent = '🎤';
            }
        });
    }

    /* ------------------------------------------------------------------ */
    /*  Welcome message                                                    */
    /* ------------------------------------------------------------------ */

    renderWelcome() {
        const welcome = this.config.welcome;
        if (!welcome) return;

        const el = document.createElement('div');
        el.className = 'chat-message assistant welcome-message';

        let html = '';
        if (welcome.message) {
            html += `<p>${this.escapeHtml(welcome.message)}</p>`;
        }
        if (welcome.examples?.length) {
            html += '<ul class="welcome-examples">';
            for (const ex of welcome.examples) {
                html += `<li><button class="welcome-example-btn">${this.escapeHtml(ex)}</button></li>`;
            }
            html += '</ul>';
        }

        el.innerHTML = html;

        // Click handler: populate input field
        el.querySelectorAll('.welcome-example-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.inputEl.value = btn.textContent;
                this.inputEl.focus();
            });
        });

        this.messagesEl.appendChild(el);
    }

    /* ------------------------------------------------------------------ */
    /*  Optional links: github, docs (header), carbon (footer left)        */
    /* ------------------------------------------------------------------ */

    initLinks() {
        const links = this.config.links;
        if (!links) return;

        // Header links: About (docs) + GitHub octocat
        if (links.docs || links.github) {
            const headerLinks = document.createElement('div');
            headerLinks.className = 'header-links';

            if (links.docs) {
                const a = document.createElement('a');
                a.href = links.docs;
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
                a.className = 'header-link docs-link';
                a.textContent = 'About';
                a.title = 'Documentation';
                headerLinks.appendChild(a);
            }

            if (links.github) {
                const a = document.createElement('a');
                a.href = links.github;
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
                a.className = 'header-link github-link';
                a.title = 'Source code';
                // GitHub mark SVG (official)
                a.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;
                headerLinks.appendChild(a);
            }

            const header = this.headerEl;
            const toggleBtn = this.toggleBtn;
            if (header && toggleBtn) {
                header.insertBefore(headerLinks, toggleBtn);
            }
        }

        // Footer left: carbon dashboard (NRP deployments only)
        if (links.carbon) {
            const footer = this.footerEl;
            if (!footer) return;

            const a = document.createElement('a');
            a.href = 'https://carbon-api.nrp-nautilus.io/';
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.className = 'footer-link carbon-link';
            a.title = 'Carbon dashboard — energy use for this deployment';
            // Leaf SVG
            a.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M17 8C8 10 5.9 16.17 3.82 21.34L5.71 22l1-2.3A4.49 4.49 0 008 20C19 20 22 3 22 3c-1 2-8 5.5-8.5 11.5-2.05-1.05-3.72-3.07-3.72-5.5 0-.67.19-1.3.52-1.83A4.89 4.89 0 0017 8z"/></svg>`;
            footer.prepend(a);
        }
    }

    /* ------------------------------------------------------------------ */
    /*  Settings panel (user-provided API key mode)                         */
    /* ------------------------------------------------------------------ */

    initSettingsUI() {
        const footer = this.footerRightEl;
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
    /*  Auto-approve toggle                                                */
    /* ------------------------------------------------------------------ */

    initAutoApproveToggle() {
        const footer = this.footerRightEl;
        if (!footer) return;

        // Resolve initial state: localStorage > config
        const stored = localStorage.getItem('geo-agent-auto-approve');
        const initial = stored !== null ? stored === 'true' : (this.config.auto_approve ?? false);
        this.agent.autoApprove = initial;

        const btn = document.createElement('button');
        btn.id = 'auto-approve-btn';
        btn.title = 'Auto-approve tool calls (skip confirmation prompts)';
        btn.textContent = '⚡';
        btn.classList.toggle('active', initial);

        btn.addEventListener('click', () => {
            this.agent.autoApprove = !this.agent.autoApprove;
            btn.classList.toggle('active', this.agent.autoApprove);
            localStorage.setItem('geo-agent-auto-approve', this.agent.autoApprove);
        });

        footer.prepend(btn);
    }

    /* ------------------------------------------------------------------ */
    /*  Send handler                                                       */
    /* ------------------------------------------------------------------ */

    async handleSend() {
        const text = this.inputEl.value.trim();
        if (!text) return;
        if (this.busy) return;

        // In user-provided mode, check for API key before sending
        if (this.config._userProvidedMode && !localStorage.getItem('geo-agent-api-key')) {
            this.showSettingsPanel();
            return;
        }

        this.busy = true;
        this.sendBtn.disabled = true;
        this.inputEl.value = '';

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
            const msg = err.message || String(err);
            const isNetworkOrTimeout =
                msg.toLowerCase().includes('fetch') ||
                msg.toLowerCase().includes('timed out') ||
                err.name === 'TypeError';
            this.addMessage('error', isNetworkOrTimeout
                ? 'LLM timeout or network error. Type "continue" to resume, or try selecting a different model if this persists.'
                : msg);
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

    showToolExecuting(calls) {
        this.removeToolExecuting();
        const hasSql = calls.some(tc => {
            try {
                const args = JSON.parse(tc.function.arguments);
                return !!(args.sql_query || args.query || args.sql);
            } catch { return false; }
        });
        const label = hasSql ? 'Running query' : 'Running';
        const el = document.createElement('div');
        el.className = 'chat-message assistant-thinking';
        el.id = 'tool-executing-indicator';
        el.innerHTML = `${label}<span class="loading-dots"></span>`;
        this.messagesEl.appendChild(el);
        this.scrollToBottom();
    }

    removeToolExecuting() {
        document.getElementById('tool-executing-indicator')?.remove();
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

        // Show plain-english description above the fold for proposals requiring approval.
        // Use model-provided reasoning if available, otherwise derive from tool args.
        let html = '';
        if (!autoApproved) {
            const desc = (reasoningText && reasoningText.trim())
                ? reasoningText.trim()
                : this.describeToolCalls(calls);
            if (desc) {
                const descHtml = typeof marked !== 'undefined' ? marked.parse(desc) : this.escapeHtml(desc);
                html += `<div class="tool-reasoning">${descHtml}</div>`;
            }
        }

        // Build collapsible header
        const names = calls.map(c => c.function.name).join(', ');
        const label = autoApproved ? `Running: ${names}` : `Details: ${names}`;

        html += `<details><summary class="query-summary-btn">${label}</summary><div class="tool-detail">`;

        for (const tc of calls) {
            let args;
            try { args = JSON.parse(tc.function.arguments); } catch { args = tc.function.arguments; }

            let argDisplay = '';
            if (typeof args === 'object' && args !== null) {
                // Extract SQL query field and display it highlighted with real newlines
                const sqlText = args.sql_query || args.query || args.sql || null;
                const sqlKey = args.sql_query !== undefined ? 'sql_query' : args.query !== undefined ? 'query' : 'sql';
                if (sqlText) {
                    argDisplay += `<details class="sql-detail"><summary>SQL</summary><pre><code class="language-sql">${this.escapeHtml(sqlText)}</code></pre></details>`;
                    const REDACTED_KEYS = ['s3_key', 's3_secret', 's3_endpoint', 's3_scope', 'catalog_token'];
                    const otherArgs = Object.fromEntries(
                        Object.entries(args).filter(([k]) => k !== sqlKey && !REDACTED_KEYS.includes(k))
                    );
                    if (Object.keys(otherArgs).length > 0) {
                        argDisplay += `<pre><code>${this.escapeHtml(JSON.stringify(otherArgs, null, 2))}</code></pre>`;
                    }
                } else {
                    argDisplay = `<pre><code>${this.escapeHtml(JSON.stringify(args, null, 2))}</code></pre>`;
                }
            } else {
                argDisplay = `<pre><code>${this.escapeHtml(String(args))}</code></pre>`;
            }

            html += `<div class="tool-call-item"><strong>${tc.function.name}</strong>${argDisplay}</div>`;
        }

        html += '</div></details>';

        if (!autoApproved) {
            html += '<div class="tool-approval-buttons"><button class="approve-btn approve-yes">▶ Run</button><button class="approve-btn approve-no" style="background:#dc3545">✕ Cancel</button></div>';
        }
        block.innerHTML = html;
        this.messagesEl.appendChild(block);

        // Highlight any SQL blocks in the proposal
        block.querySelectorAll('code.language-sql').forEach(el => {
            if (typeof hljs !== 'undefined') hljs.highlightElement(el);
        });

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
        this.removeToolExecuting();
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

    /**
     * Generate a fallback plain-english description from tool call arguments
     * when the model does not provide reasoning text alongside tool calls.
     * See docs/agent-loop.md for why this fallback exists and alternatives.
     */
    describeToolCalls(calls) {
        const parts = calls.map(tc => {
            let args;
            try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
            const sql = args.sql_query || args.query || args.sql;
            if (sql) return this.describeSql(sql);
            return `Will call \`${tc.function.name}\`.`;
        });
        return parts.join(' ');
    }

    /**
     * Parse a SQL string and produce a concise plain-english summary.
     * Detects tables, joins, aggregations, filtering, and grouping.
     */
    describeSql(sql) {
        const s = sql.replace(/\s+/g, ' ');

        // Extract all read_parquet paths → short two-segment names
        const tableNames = [...s.matchAll(/read_parquet\s*\(\s*['"]([^'"]+)['"]\s*\)/gi)]
            .map(m => m[1].split('/').filter(p => p && !p.includes('*')).slice(-2).join('/'));
        const uniqueTables = [...new Set(tableNames)];

        // Detect operation types
        const hasAgg   = /\b(SUM|AVG|COUNT|MIN|MAX)\s*\(/i.test(s);
        const hasJoin  = /\bJOIN\b/i.test(s);
        const hasWhere = /\bWHERE\b/i.test(s);
        const hasGroup = /\bGROUP\s+BY\b/i.test(s);
        const hasOrder = /\bORDER\s+BY\b/i.test(s);
        const hasLimit = /\bLIMIT\s+\d+/i.test(s);

        // Build description
        let action = hasAgg ? 'Computing aggregates' : 'Querying data';

        let tableDesc = '';
        if (uniqueTables.length === 1) {
            tableDesc = ` from \`${uniqueTables[0]}\``;
        } else if (uniqueTables.length === 2) {
            tableDesc = ` joining \`${uniqueTables[0]}\` with \`${uniqueTables[1]}\``;
        } else if (uniqueTables.length > 2) {
            tableDesc = ` across ${uniqueTables.length} datasets`;
        }

        const qualifiers = [];
        if (hasWhere) qualifiers.push('filtered by conditions');
        if (hasGroup) qualifiers.push('grouped by category');
        if (hasOrder && hasLimit) qualifiers.push('returning top results');

        let desc = action + tableDesc;
        if (qualifiers.length > 0) desc += ', ' + qualifiers.join(', ');
        return desc + '.';
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
