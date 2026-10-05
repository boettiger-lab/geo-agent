/**
 * ChatUI - Thin UI shell for the chat interface.
 *
 * Owns all DOM manipulation. Consumes events from Agent.
 * Renders collapsible tool-call blocks (VSCode Copilot-inspired).
 */

import { CARBON_DASHBOARD_URL } from './app-header.js';
import { ensurePanelActions } from './panel-actions.js';
import { githubIcon, leafIcon } from './icons.js';

import {
    PUBLIC_S3_ENDPOINT,
    resolveExportConfig,
    buildDuckdbSetupSql,
    CODE_LANGUAGES,
    buildSetupSnippet,
    wrapQuery,
    scrubCredentials,
    REDACTED_KEYS,
    EXPORT_MAP_MAPLIBRE_VERSION,
    EXPORT_MAP_PMTILES_VERSION,
    buildMapEmbedHtml,
    renderMarkdown,
    buildReportHtml,
    chartIdOf,
    libraryVersion,
} from './export-report.js';

// Re-exported so existing importers (and tests) keep resolving them here.
export {
    PUBLIC_S3_ENDPOINT,
    resolveExportConfig,
    buildDuckdbSetupSql,
    CODE_LANGUAGES,
    buildSetupSnippet,
    wrapQuery,
    scrubCredentials,
    REDACTED_KEYS,
    EXPORT_MAP_MAPLIBRE_VERSION,
    EXPORT_MAP_PMTILES_VERSION,
    buildMapEmbedHtml,
    renderMarkdown,
};


export class ChatUI {
    /**
     * @param {import('./agent.js').Agent} agent
     * @param {Object} config  - app config (for model list)
     * @param {Object} mount   - DOM refs from layout-manager.buildLayout()
     *   {
     *     container, messages, input, send, mic, header, footer, footerRight,
     *   }
     * @param {import('./map-manager.js').MapManager} [mapManager] - used by the
     *   HTML export to embed the final map state; optional so tests and
     *   headless harnesses can construct a ChatUI without a live map.
     * @param {import('./chart-renderer.js').ChartRenderer} [chartRenderer] -
     *   used by the HTML export to re-draw each chart as a figure; null when
     *   the app has charts off.
     */
    constructor(agent, config, mount, mapManager = null, chartRenderer = null) {
        this.agent = agent;
        this.config = config;
        // Export settings (opt-out + endpoint), resolved once — initExportButton
        // needs them before any DOM is built.
        this.exportConfig = resolveExportConfig(config);
        this.mapManager = mapManager;
        this.chartRenderer = chartRenderer;
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
        // True when the app header already renders `links` as top-level nav.
        this.linksAbsorbed = Boolean(mount.linksAbsorbed);
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
        // Default placeholder, restored by _syncInputControls when not paused.
        this._defaultPlaceholder = this.inputEl.placeholder;

        // The send button is a 3-state control:
        //   idle           → "Send"      (click/Enter sends a new message)
        //   busy           → "■" Stop    (click/Esc aborts the in-flight turn)
        //   suspended+idle → "Continue"  (click/Enter resumes the paused turn;
        //                                 typing a steer first resumes with it)
        // While busy it aborts; otherwise it sends/resumes via handleSend.
        this.sendBtn.addEventListener('click', () => {
            if (this.busy) this.agent.abort();
            else this.handleSend();
        });

        // Abandon control — shown only while a turn is suspended (and not busy).
        // Discards the preserved work so the next message starts a fresh turn,
        // instead of being folded into the old turn as a steer.
        this.abandonBtn = document.createElement('button');
        this.abandonBtn.id = 'chat-abandon';
        this.abandonBtn.type = 'button';
        this.abandonBtn.textContent = '✕';
        this.abandonBtn.title = 'Discard the paused work and start fresh';
        this.abandonBtn.setAttribute('aria-label', 'Discard the paused work and start fresh');
        this.abandonBtn.hidden = true;
        this.abandonBtn.addEventListener('click', () => this.abandonSuspendedTurn());
        this.sendBtn.parentNode.insertBefore(this.abandonBtn, this.sendBtn);
        this._syncInputControls();
        this.inputEl.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.handleSend();
            }
        });
        this.inputEl.addEventListener('input', () => this._autoResizeInput());

        // Wire collapse toggle
        this.toggleBtn?.addEventListener('click', () => {
            this.container.classList.toggle('collapsed');
        });

        // Populate model selector
        this.populateModelSelector();
        this.modelSelector?.addEventListener('change', () => {
            this.agent.setModel(this.modelSelector.value);
            // setModel cleared any reasoning override; reflect the new model's
            // capability + default in the toggle.
            this.syncReasoningToggle();
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

        // Reasoning on/off toggle (shown only for reasoning-capable models)
        this.initReasoningToggle();

        // Export-to-HTML button (unless the app opted out)
        this.initExportButton();

        // Optional header/footer links (github, docs, carbon)
        this.initLinks();

        // Wire agent callbacks
        this.agent.onThinkingStart = () => this.showThinking();
        this.agent.onThinkingEnd = () => this.hideThinking();
        this.agent.onReasoning = (text, iter) => this.showReasoning(text, iter);
        this.agent.onToolProposal = (calls, text, iter, autoApproved) =>
            this.showToolProposal(calls, text, iter, autoApproved);
        this.agent.onToolExecuting = (calls) => this.showToolExecuting(calls);
        this.agent.onToolResults = (results, iter) => this.showToolResults(results, iter);
        this.agent.onError = (err) => this.addMessage('error', err);
        this.agent.onRetry = (err) => {
            const reason = err?.timedOut ? 'timeout' : (err?.status ? `HTTP ${err.status}` : 'network error');
            this.addMessage('system', `Transient ${reason} — retrying with shorter timeout...`);
        };

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
                    this._autoResizeInput();
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
                this._autoResizeInput();
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
        // The app header renders the same links as top-level nav when one is
        // configured; showing them here too would duplicate every entry.
        if (this.linksAbsorbed) return;

        // All links live in the footer-left zone in both floating and sidebar
        // modes. The header is kept link-free.
        const footer = this.footerEl;
        if (!footer) return;

        // Reverse append order: we prepend each link to the footer so that the
        // final left-to-right ordering is docs | github | carbon.
        // (prepend reverses insertion order — insert carbon first, then github,
        //  then docs.)

        if (links.carbon) {
            const a = document.createElement('a');
            a.href = typeof links.carbon === 'string' ? links.carbon : CARBON_DASHBOARD_URL;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.className = 'footer-link carbon-link';
            a.title = 'Carbon dashboard — energy use for this deployment';
            a.innerHTML = leafIcon(15);
            footer.prepend(a);
        }

        if (links.github) {
            const a = document.createElement('a');
            a.href = links.github;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.className = 'footer-link github-link';
            a.title = 'Source code';
            a.innerHTML = githubIcon(16);
            footer.prepend(a);
        }

        if (links.docs) {
            const a = document.createElement('a');
            a.href = links.docs;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.className = 'footer-link docs-link';
            a.textContent = 'About';
            a.title = 'Documentation';
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

        const initial = this.config.auto_approve ?? true;
        this.agent.autoApprove = initial;

        const btn = document.createElement('button');
        btn.id = 'auto-approve-btn';
        btn.title = 'Auto-approve tool calls (skip confirmation prompts)';
        btn.textContent = '⚡';
        btn.classList.toggle('active', initial);

        btn.addEventListener('click', () => {
            this.agent.autoApprove = !this.agent.autoApprove;
            btn.classList.toggle('active', this.agent.autoApprove);
        });

        footer.prepend(btn);
    }

    /* ------------------------------------------------------------------ */
    /*  Reasoning on/off toggle                                            */
    /* ------------------------------------------------------------------ */

    /**
     * The effective reasoning state shown by the toggle: a per-conversation
     * user override if set, else the model's configured default, else `true`
     * (reasoning-capable models think by default).
     */
    reasoningState() {
        const mc = this.agent.getModelConfig();
        if (typeof this.agent.reasoningOverride === 'boolean') return this.agent.reasoningOverride;
        const dflt = this.agent._reasoningDefault(mc);
        return typeof dflt === 'boolean' ? dflt : true;
    }

    /** Reflect capability (show/hide) and current state (active class + title). */
    syncReasoningToggle() {
        const btn = this.reasoningBtn;
        if (!btn) return;
        const capable = this.agent._reasoningCapable(this.agent.getModelConfig());
        btn.style.display = capable ? '' : 'none';
        if (!capable) return;
        const on = this.reasoningState();
        btn.classList.toggle('active', on);
        btn.title = on
            ? 'Reasoning on — the model thinks before answering (slower, better on hard questions). Click for faster answers.'
            : 'Reasoning off — faster answers, may reduce quality on hard questions. Click to think first.';
    }

    initReasoningToggle() {
        const footer = this.footerRightEl;
        if (!footer) return;

        const btn = document.createElement('button');
        btn.id = 'reasoning-btn';
        btn.textContent = '🧠';
        btn.addEventListener('click', () => {
            this.agent.reasoningOverride = !this.reasoningState();
            this.syncReasoningToggle();
        });

        footer.prepend(btn);
        this.reasoningBtn = btn;
        this.syncReasoningToggle();
    }

    /* ------------------------------------------------------------------ */
    /*  Export-to-HTML button                                              */
    /* ------------------------------------------------------------------ */

    initExportButton() {
        // Opt-out apps get no button at all, rather than a disabled one —
        // nothing left for a console to re-enable.
        if (!this.exportConfig?.enabled) return;

        // Prefer the layer panel's action row, so Export sits beside Upload
        // rather than alone in the footer. Falls back to the footer when
        // there is no layer panel (floating mode, or a headless harness).
        const controls = document.getElementById('layer-controls-container');
        const row = controls ? ensurePanelActions(controls) : null;
        const host = row || this.footerRightEl;
        if (!host) return;

        const btn = document.createElement('button');
        btn.id = 'export-btn';
        btn.className = row ? 'panel-btn' : '';
        btn.title = 'Save this conversation as a self-contained HTML document you can share or print.';
        btn.textContent = row ? '\u{1F4BE} Export session' : '\u{1F4BE}';
        btn.disabled = true;

        btn.addEventListener('click', () => {
            if (btn.disabled) return;
            this.exportHtml();
        });

        if (row) host.appendChild(btn);
        else host.prepend(btn);
        this._exportBtn = btn;

        // Observe messagesEl for the first real turn appearing; enable once
        // we see a .chat-message.user or an .agent-turn child.
        const refresh = () => {
            const hasTurn = !!this.messagesEl.querySelector(
                '.chat-message.user, .agent-turn'
            );
            btn.disabled = !hasTurn;
        };
        refresh();
        const observer = new MutationObserver(refresh);
        observer.observe(this.messagesEl, { childList: true, subtree: true });
    }

    /*  Send handler                                                       */
    /* ------------------------------------------------------------------ */

    _autoResizeInput() {
        this.inputEl.style.height = 'auto';
        this.inputEl.style.height = this.inputEl.scrollHeight + 'px';
    }

    async handleSend() {
        if (this.busy) return;

        // Empty input resumes a paused turn (Continue); otherwise there's
        // nothing to send. A typed steer takes precedence over the canned resume.
        let text = this.inputEl.value.trim();
        if (!text) {
            if (!this.agent.suspendedTurn) return;
            text = 'continue';
        }

        // In user-provided mode, check for API key before sending
        if (this.config._userProvidedMode && !localStorage.getItem('geo-agent-api-key')) {
            this.showSettingsPanel();
            return;
        }

        this.busy = true;
        this._syncInputControls();
        this.inputEl.value = '';
        this._autoResizeInput();

        // Esc anywhere on the page while busy → stop.
        const escHandler = (e) => {
            if (e.key === 'Escape') this.agent.abort();
        };
        document.addEventListener('keydown', escHandler);

        this.addMessage('user', text);
        this.startTurn();

        try {
            const { response, cancelled } = await this.agent.processMessage(text);

            if (cancelled) {
                this.endTurn('cancelled');
                this.addMessage('system', 'Query cancelled.');
            } else if (response) {
                this.endTurn('done');
                this.addMarkdown('assistant', response);
            } else {
                this.endTurn('done');
            }
            // If the turn paused with work preserved (a checkpoint, or Stop
            // during the checkpoint summary), _syncInputControls() in finally
            // relabels the send button to "Continue" and reveals the abandon
            // control — the input area itself becomes the resume affordance.
        } catch (err) {
            console.error('[ChatUI] Error:', err);
            this.endTurn('error');
            const msg = err.message || String(err);
            const isNetworkOrTimeout =
                msg.toLowerCase().includes('fetch') ||
                msg.toLowerCase().includes('timed out') ||
                err.name === 'TypeError';
            this.addMessage('error', isNetworkOrTimeout
                ? 'LLM timeout or network error. Type "continue" to resume, or try selecting a different model if this persists.'
                : msg);
        } finally {
            const rec = this._recordCurrent();
            if (rec) rec.closed = true;
            this.busy = false;
            this._syncInputControls();
            document.removeEventListener('keydown', escHandler);
            this.inputEl.focus();
        }
    }

    /**
     * Reflect the current (busy / suspended / idle) state onto the input
     * controls. Single source of truth for the send button's three modes and
     * the abandon button's visibility, so the wiring lives in one place.
     */
    _syncInputControls() {
        const suspended = !this.busy && !!this.agent.suspendedTurn;
        this.sendBtn.classList.toggle('stop', this.busy);
        this.sendBtn.classList.toggle('continue', suspended);
        if (this.busy) {
            this.sendBtn.textContent = '■';
            this.sendBtn.title = 'Stop';
        } else if (suspended) {
            this.sendBtn.textContent = 'Continue';
            this.sendBtn.title = 'Resume where the agent paused — or type a steer first';
        } else {
            this.sendBtn.textContent = 'Send';
            this.sendBtn.title = '';
        }
        this.abandonBtn.hidden = !suspended;
        this.inputEl.placeholder = suspended
            ? 'Press Continue, or type a steer / choice to resume…'
            : this._defaultPlaceholder;
    }

    /**
     * Discard a suspended turn so the next message starts fresh rather than
     * being folded into the paused turn as a steer. Wired to the abandon (✕)
     * button, which is only visible while a turn is suspended.
     */
    abandonSuspendedTurn() {
        if (this.busy || !this.agent.suspendedTurn) return;
        this.agent.suspendedTurn = null;
        this._syncInputControls();
        this.addMessage('system', 'Discarded the paused work. Your next message starts a new turn.');
    }

    /* ------------------------------------------------------------------ */
    /*  Per-turn timeline                                                  */
    /* ------------------------------------------------------------------ */

    /**
     * Open a new agent-turn container. All subsequent agent events
     * (reasoning, tool proposals, tool results) route into it as compact
     * rows, and the whole container collapses to a one-liner when the
     * assistant's final answer arrives.
     */
    startTurn() {
        const container = document.createElement('details');
        container.className = 'agent-turn running';
        container.open = true;

        const summary = document.createElement('summary');
        summary.className = 'agent-turn-summary';
        summary.innerHTML = '<span class="agent-turn-label">Working</span><span class="loading-dots"></span>';

        const body = document.createElement('div');
        body.className = 'agent-turn-body';

        container.appendChild(summary);
        container.appendChild(body);
        this.messagesEl.appendChild(container);

        this.currentTurn = {
            container,
            summary,
            body,
            startedAt: Date.now(),
            rowsByIter: new Map(),
            stepCount: 0,
        };
        this.scrollToBottom();
    }

    /**
     * Close the current agent-turn container and rewrite its summary to a
     * one-liner: "▸ N steps · 12.3s ✓". Status may be 'done', 'error',
     * 'cancelled'.
     */
    endTurn(status = 'done') {
        const rec = this._recordCurrent();
        if (rec) rec.status = status;
        if (!this.currentTurn) return;
        this.removeThinkingRow();

        const { container, summary, body, startedAt, stepCount } = this.currentTurn;
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

        const icon = status === 'done' ? '✓' : '✕';
        const stepsLabel = stepCount === 0 ? '0 steps' :
                           stepCount === 1 ? '1 step' :
                           `${stepCount} steps`;

        summary.innerHTML =
            `<span class="agent-turn-icon ${status}">${icon}</span>` +
            `<span class="agent-turn-label">${stepsLabel} · ${elapsed}s</span>`;

        container.classList.remove('running');
        container.classList.add(status);

        // Empty turns (direct answer, no tools/reasoning) are noise — drop them.
        if (stepCount === 0 && status === 'done') {
            container.remove();
        } else {
            container.open = false;
        }

        this.currentTurn = null;
    }

    /* ------------------------------------------------------------------ */
    /*  Thinking row (transient, inside the current turn)                  */
    /* ------------------------------------------------------------------ */

    showThinking() {
        if (this.currentTurn) {
            this.removeThinkingRow();
            const row = document.createElement('div');
            row.className = 'agent-turn-row thinking';
            row.id = 'turn-thinking-row';
            row.innerHTML = '<span class="row-icon">·</span><span class="row-label">Thinking</span><span class="loading-dots"></span>';
            this.currentTurn.body.appendChild(row);
            this.scrollToBottom();
            return;
        }
        // Fallback for cases where no turn is active (shouldn't happen in normal flow).
        this.removeThinking();
        const el = document.createElement('div');
        el.className = 'chat-message assistant-thinking';
        el.id = 'thinking-indicator';
        el.innerHTML = 'Thinking<span class="loading-dots"></span>';
        this.messagesEl.appendChild(el);
        this.scrollToBottom();
    }

    hideThinking() {
        this.removeThinkingRow();
        this.removeThinking();
    }

    removeThinking() {
        document.getElementById('thinking-indicator')?.remove();
    }

    removeThinkingRow() {
        document.getElementById('turn-thinking-row')?.remove();
    }

    /* ------------------------------------------------------------------ */
    /*  Tool execution indicator (no-op now: state lives on the row)       */
    /* ------------------------------------------------------------------ */

    showToolExecuting(_calls) {
        // The tool row already shows a running spinner from showToolProposal
        // onward; no separate indicator needed in the timeline layout.
    }

    /* ------------------------------------------------------------------ */
    /*  Reasoning row                                                      */
    /* ------------------------------------------------------------------ */

    showReasoning(text, _iter) {
        if (!this.currentTurn) return;
        this.removeThinkingRow();

        const row = document.createElement('details');
        row.className = 'agent-turn-row reasoning';

        const summary = document.createElement('summary');
        summary.className = 'agent-turn-row-summary';
        summary.innerHTML = '<span class="row-icon">💭</span><span class="row-label">Reasoning</span>';

        const body = document.createElement('div');
        body.className = 'agent-turn-row-body';
        body.innerHTML = renderMarkdown(text);

        row.appendChild(summary);
        row.appendChild(body);
        this.currentTurn.body.appendChild(row);
        this.currentTurn.stepCount++;
        this.scrollToBottom();
    }

    /* ------------------------------------------------------------------ */
    /*  Tool proposal & results (merged into one mutable row per iter)     */
    /* ------------------------------------------------------------------ */

    /**
     * Create a tool row in 'running' state. If autoApproved is true the
     * call proceeds immediately; otherwise approval buttons are shown
     * inside the row body and the returned promise resolves when the user
     * decides.
     */
    showToolProposal(calls, reasoningText, iteration, autoApproved = false) {
        this._recordProposal(calls, iteration);
        if (!this.currentTurn) return Promise.resolve({ approved: true });
        this.removeThinkingRow();

        // Group repeated tool names for a compact label: "query ×3"
        const counts = new Map();
        for (const c of calls) {
            counts.set(c.function.name, (counts.get(c.function.name) || 0) + 1);
        }
        const namesLabel = [...counts.entries()]
            .map(([n, c]) => c > 1 ? `${n} ×${c}` : n)
            .join(', ');

        const row = document.createElement('details');
        row.className = 'agent-turn-row tool running';
        row.dataset.iter = String(iteration);

        const summary = document.createElement('summary');
        summary.className = 'agent-turn-row-summary';
        summary.innerHTML =
            '<span class="row-icon">⚙</span>' +
            `<span class="row-label">${this.escapeHtml(namesLabel)}</span>` +
            '<span class="row-status running"><span class="loading-dots"></span></span>';

        const body = document.createElement('div');
        body.className = 'agent-turn-row-body';

        // Optional plain-english description above the fold (shown for
        // non-auto-approve proposals so the user can decide).
        if (!autoApproved) {
            const desc = (reasoningText && reasoningText.trim())
                ? reasoningText.trim()
                : this.describeToolCalls(calls);
            if (desc) {
                const descHtml = renderMarkdown(desc);
                body.insertAdjacentHTML('beforeend', `<div class="tool-reasoning">${descHtml}</div>`);
            }
        }

        for (const tc of calls) {
            body.insertAdjacentHTML('beforeend', this.renderToolCallArgs(tc));
        }

        row.appendChild(summary);
        row.appendChild(body);
        this.currentTurn.body.appendChild(row);
        this.currentTurn.rowsByIter.set(iteration, row);
        this.currentTurn.stepCount++;

        row.querySelectorAll('code.language-sql').forEach(el => {
            if (typeof hljs !== 'undefined') hljs.highlightElement(el);
        });

        this.scrollToBottom();

        if (autoApproved) return Promise.resolve({ approved: true });

        // Open the row so the user can see what's being proposed.
        row.open = true;
        body.insertAdjacentHTML('beforeend',
            '<div class="tool-approval-buttons">' +
            '<button class="approve-btn approve-yes">▶ Run</button>' +
            '<button class="approve-btn approve-no" style="background:#dc3545">✕ Cancel</button>' +
            '</div>'
        );

        return new Promise(resolve => {
            const yesBtn = row.querySelector('.approve-yes');
            const noBtn = row.querySelector('.approve-no');
            const cleanup = () => row.querySelector('.tool-approval-buttons')?.remove();

            yesBtn.addEventListener('click', () => {
                cleanup();
                resolve({ approved: true });
            });
            noBtn.addEventListener('click', () => {
                cleanup();
                resolve({ approved: false });
            });
        });
    }

    /**
     * Render the body block for one tool call (args, with SQL pretty-print
     * and redaction of credential-like keys).
     */
    renderToolCallArgs(tc) {
        let args;
        try { args = JSON.parse(tc.function.arguments); } catch { args = tc.function.arguments; }

        let argDisplay = '';
        if (typeof args === 'object' && args !== null) {
            const sqlText = args.sql_query || args.query || args.sql || null;
            const sqlKey = args.sql_query !== undefined ? 'sql_query' : args.query !== undefined ? 'query' : 'sql';
            if (sqlText) {
                argDisplay += `<details class="sql-detail"><summary>SQL</summary><pre><code class="language-sql">${this.escapeHtml(sqlText)}</code></pre></details>`;
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

        return `<div class="tool-call-item"><strong>${this.escapeHtml(tc.function.name)}</strong>${argDisplay}</div>`;
    }

    /**
     * Mutate the tool row created in showToolProposal: change its status
     * icon and append the result panels to the body.
     */
    showToolResults(results, iteration) {
        this._recordResults(results, iteration);
        if (!this.currentTurn) return;
        const row = this.currentTurn.rowsByIter.get(iteration);
        if (!row) return;

        const anyError = results.some(r => !r.success);
        const status = anyError ? 'error' : 'done';
        const icon = anyError ? '✗' : '✓';

        row.classList.remove('running');
        row.classList.add(status);

        const statusEl = row.querySelector('.row-status');
        if (statusEl) {
            statusEl.className = `row-status ${status}`;
            statusEl.textContent = icon;
        }

        const body = row.querySelector('.agent-turn-row-body');
        if (!body) return;

        let resultsHtml = '<div class="tool-results-list">';
        for (const r of results) {
            const itemIcon = r.success ? '✓' : '✗';
            const sourceTag = r.source === 'remote' ? ' <span class="tool-tag remote">MCP</span>' : '';
            const truncated = this.truncateResult(r.result, 2000);
            resultsHtml += `<div class="tool-result-item"><strong>${itemIcon} ${this.escapeHtml(r.name)}</strong>${sourceTag}`;
            if (r.sqlQuery) {
                resultsHtml += `<details class="sql-detail"><summary>SQL</summary><pre><code class="language-sql">${this.escapeHtml(r.sqlQuery)}</code></pre></details>`;
            }
            resultsHtml += `<pre class="tool-output"><code>${this.escapeHtml(truncated)}</code></pre></div>`;
        }
        resultsHtml += '</div>';
        body.insertAdjacentHTML('beforeend', resultsHtml);

        // Highlight any new SQL blocks in the appended results
        body.querySelectorAll('code.language-sql:not(.hljs)').forEach(el => {
            if (typeof hljs !== 'undefined') hljs.highlightElement(el);
        });

        this.scrollToBottom();
    }

    /* ------------------------------------------------------------------ */
    /*  HTML export                                                        */
    /* ------------------------------------------------------------------ */

    /* ------------------------------------------------------------------ */
    /*  Session record (what the export is built from, #388)               */
    /* ------------------------------------------------------------------ */

    /**
     * The session as a structured record, accumulated alongside the DOM so
     * the export never has to read the chat panel back. Lazily created, so a
     * ChatUI built with `Object.create` (tests, the sample generator) works.
     */
    _session() {
        if (!this.session) this.session = { turns: [], pendingNotes: [] };
        return this.session;
    }

    /** The turn events attach to: the latest, unless it has closed. */
    _recordCurrent() {
        const turns = this._session().turns;
        const last = turns[turns.length - 1];
        return last && !last.closed ? last : null;
    }

    /** The model a turn starts on, by id and by the label the app shows. */
    _currentModel() {
        const id = this.agent?.selectedModel;
        if (!id) return null;
        const label = this.config?.llm_models?.find(m => m.value === id)?.label || null;
        return { id, label };
    }

    _recordMessage(role, text) {
        const session = this._session();
        if (role === 'user') {
            for (const t of session.turns) t.closed = true;
            session.turns.push({
                prompt: String(text ?? ''),
                model: this._currentModel(),
                startedAt: new Date().toISOString(),
                status: 'running',
                steps: [],
                answer: null,
                // System lines that arrived between questions ("Region drawn
                // on map") are context for this one.
                context: session.pendingNotes.splice(0),
                notes: [],
                _calls: new Map(),
            });
            return;
        }
        if (role !== 'system' && role !== 'error') return;
        const rec = this._recordCurrent();
        const note = { role, text: String(text ?? '') };
        if (rec) rec.notes.push(note);
        else session.pendingNotes.push(note);
    }

    _recordProposal(calls, iteration) {
        const rec = this._recordCurrent();
        if (rec) rec._calls.set(iteration, calls || []);
    }

    /** Pair each result with the call that produced it (the agent keeps order). */
    _recordResults(results, iteration) {
        const rec = this._recordCurrent();
        if (!rec) return;
        const calls = rec._calls.get(iteration) || [];
        (results || []).forEach((r, i) => {
            const fn = calls[i]?.function;
            let args = fn?.arguments ?? null;
            if (typeof args === 'string') {
                try { args = JSON.parse(args); } catch { /* keep the raw string */ }
            }
            rec.steps.push({
                name: r.name || fn?.name || 'unknown',
                args,
                success: r.success !== false && r.source !== 'error',
                source: r.source || null,
                result: typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? ''),
                ...(r.sqlQuery ? { sqlQuery: r.sqlQuery } : {}),
            });
        });
        rec._calls.delete(iteration);
    }

    /* ------------------------------------------------------------------ */
    /*  HTML export                                                        */
    /* ------------------------------------------------------------------ */

    /**
     * Build the session report (#388) and trigger a download: one section
     * per question, the SQL the agent ran as folded code chunks with their
     * output, the model's answer as prose, the final map as the figure, and
     * the full call log as an appendix. Built from the session record, not
     * from the chat panel's DOM.
     */
    exportHtml() {
        const exportCfg = this.exportConfig || resolveExportConfig(this.config);

        // Capture the final map state (one map per saved log). Guarded so a
        // ChatUI built without a map still exports the report.
        let mapState = null;
        try {
            mapState = this.mapManager?.getExportState?.() ?? null;
        } catch (err) {
            console.warn('[ChatUI] map capture for export failed:', err);
        }

        // Each chart the session drew, re-drawn as a static figure. Guarded
        // like the map: a failed figure costs the figure, not the export.
        const figures = new Map();
        for (const turn of this._session().turns) {
            for (const step of turn.steps) {
                const id = chartIdOf(step);
                if (!id || figures.has(id)) continue;
                try {
                    const svg = this.chartRenderer?.exportFigure?.(id);
                    if (svg) figures.set(id, svg);
                } catch (err) {
                    console.warn('[ChatUI] chart capture for export failed:', err);
                }
            }
        }

        const html = buildReportHtml(this._session(), {
            figures,
            title: this._exportTitle(),
            appTitle: document.title || 'GLEN',
            appUrl: window.location.href,
            exportedAt: new Date(),
            s3Endpoint: exportCfg.s3Endpoint,
            codeLanguage: exportCfg.codeLanguage,
            projectUrl: exportCfg.projectUrl,
            version: libraryVersion(),
            mapEmbed: buildMapEmbedHtml(mapState, { filename: this._exportFilename() }),
            basename: this._exportFilename().replace(/\.html$/, ''),
        });

        try {
            const blob = new Blob([html], { type: 'text/html' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = this._exportFilename();
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (err) {
            console.error('[ChatUI] Export failed:', err);
            this.addMessage('error',
                "couldn't generate download — your browser may not support file downloads");
        }
    }

    _exportFilename() {
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
                      `-${pad(d.getHours())}${pad(d.getMinutes())}`;
        return `glen-session-${stamp}.html`;
    }

    _exportTitle() {
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        return `${document.title || 'GLEN'} — session report, ${stamp}`;
    }

    /* ------------------------------------------------------------------ */
    /*  Message rendering                                                  */
    /* ------------------------------------------------------------------ */

    addMessage(role, text) {
        this._recordMessage(role, text);
        const el = document.createElement('div');
        el.className = `chat-message ${role}`;
        el.textContent = text;
        this.messagesEl.appendChild(el);
        this.scrollToBottom();
    }

    addMarkdown(role, md) {
        if (role === 'assistant') {
            const rec = this._recordCurrent();
            if (rec) rec.answer = rec.answer ? `${rec.answer}\n\n${md}` : md;
        }
        const el = document.createElement('div');
        el.className = `chat-message ${role}`;
        el.innerHTML = renderMarkdown(md);
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
