/**
 * ChatUI - Thin UI shell for the chat interface.
 *
 * Owns all DOM manipulation. Consumes events from Agent.
 * Renders collapsible tool-call blocks (VSCode Copilot-inspired).
 */

/**
 * Rewrite `s3://bucket/path` URLs to the public HTTPS endpoint so that the
 * SQL is re-runnable from any DuckDB with httpfs loaded, outside the
 * cluster. Mirrors (in reverse) the conversion in
 * dataset-catalog.js:460-461.
 *
 * @param {string} sql
 * @returns {string}
 */
export function rewriteS3UrlsInSql(sql) {
    if (!sql) return sql;
    return sql.replace(
        /\bs3:\/\/([A-Za-z0-9._-]+)(\/[^\s'"]*)?/g,
        (_m, bucket, path) => `https://s3-west.nrp-nautilus.io/${bucket}${path || ''}`
    );
}

/**
 * Defense-in-depth credential scrub. Replaces credential-shaped tokens with
 * `[REDACTED]`. Each pattern requires a quoted value or structured
 * delimiter, so false positives in prose are unlikely.
 *
 * @param {string} text
 * @returns {string}
 */
export function scrubCredentials(text) {
    if (text === '' || text == null) return text;

    let out = text;

    // DuckDB CREATE SECRET — KEY_ID 'value' / SECRET 'value'
    out = out.replace(/(KEY_ID)\s+'[^']*'/gi, '$1 [REDACTED]');
    out = out.replace(/(\bSECRET)\s+'[^']*'/gi, '$1 [REDACTED]');

    // json/yaml/python access key assignments
    out = out.replace(
        /((?:aws_)?access_key(?:_id)?)["']?\s*([:=])\s*(['"])[^'"]+\3/gi,
        '$1$2 [REDACTED]'
    );
    out = out.replace(
        /((?:aws_)?secret(?:_access)?_key)["']?\s*([:=])\s*(['"])[^'"]+\3/gi,
        '$1$2 [REDACTED]'
    );

    // Bearer tokens
    out = out.replace(/(Authorization:)\s*Bearer\s+\S+/gi, '$1 [REDACTED]');

    // Pre-signed URL signature/credential
    out = out.replace(/X-Amz-Signature=[^&\s'"]+/gi, 'X-Amz-Signature=[REDACTED]');
    out = out.replace(/X-Amz-Credential=[^&\s'"]+/gi, 'X-Amz-Credential=[REDACTED]');
    out = out.replace(/X-Amz-Security-Token=[^&\s'"]+/gi, 'X-Amz-Security-Token=[REDACTED]');

    return out;
}

/**
 * Tool-call argument keys whose values are credentials and must never be
 * rendered to the chat or to any export. Used by both `renderToolCallArgs`
 * (live chat) and `exportHtml` (download).
 */
export const REDACTED_KEYS = ['s3_key', 's3_secret', 's3_endpoint', 's3_scope', 'catalog_token'];

/*
 * CDN builds used to re-hydrate the map in an exported transcript. Pinned to
 * match what the app itself loads (see app/index.html and
 * docs/guide/quickstart.md) so the embedded style renders under the same
 * MapLibre/PMTiles version that produced it. Bump alongside the app's pins.
 */
export const EXPORT_MAP_MAPLIBRE_VERSION = '5.22.0';
export const EXPORT_MAP_PMTILES_VERSION = '3.0.7';

/**
 * Build a self-rendering, interactive MapLibre map from a captured map state,
 * as HTML for embedding in the exported transcript. The map re-hydrates from
 * the embedded style + camera in the recipient's browser — it is live
 * (pan/zoom), not a raster snapshot, so it needs network access to the same
 * public tile sources that produced it.
 *
 * The serialized state is credential-scrubbed: AWS signatures / bearer tokens
 * (via {@link scrubCredentials}) and MapTiler `key=` params must never ride
 * along into a shared file. `<` is escaped to `<` so a source name or URL
 * containing `</script>` can't break out of the embedded JSON block.
 *
 * @param {object|null} state - from MapManager.getExportState(); null/empty → no map
 * @returns {{ headTags: string, body: string }} empty strings when there is no map
 */
export function buildMapEmbedHtml(state) {
    if (!state || !state.style) return { headTags: '', body: '' };

    let stateJson = JSON.stringify(state);
    stateJson = scrubCredentials(stateJson);
    // Redact MapTiler-style API keys in any surviving source URL.
    stateJson = stateJson.replace(/([?&]key=)[^&"'\\]+/g, '$1[REDACTED]');
    // Neutralize a </script> breakout hiding in the embedded JSON.
    const safeJson = stateJson.replace(/</g, '\\u003c');

    const ml = EXPORT_MAP_MAPLIBRE_VERSION;
    const pm = EXPORT_MAP_PMTILES_VERSION;

    const headTags =
`<link href="https://unpkg.com/maplibre-gl@${ml}/dist/maplibre-gl.css" rel="stylesheet" crossorigin="anonymous">
<script src="https://unpkg.com/maplibre-gl@${ml}/dist/maplibre-gl.js" crossorigin="anonymous"></script>
<script src="https://unpkg.com/pmtiles@${pm}/dist/pmtiles.js" crossorigin="anonymous"></script>`;

    const body =
`<section class="export-map-section">
  <h2 class="export-map-title">Map at time of export</h2>
  <div id="export-map" class="export-map"></div>
  <p class="export-map-note">Interactive map re-rendered from the saved state. Needs a network
     connection to the original public tile sources; private or signed layers may not appear.</p>
  <script type="application/json" id="export-map-state">${safeJson}</script>
  <script>
  (function () {
    var el = document.getElementById('export-map');
    try {
      if (typeof maplibregl === 'undefined') throw new Error('MapLibre GL JS did not load');
      var state = JSON.parse(document.getElementById('export-map-state').textContent);
      if (window.pmtiles && maplibregl.addProtocol) {
        maplibregl.addProtocol('pmtiles', new pmtiles.Protocol().tile);
      }
      var map = new maplibregl.Map({
        container: 'export-map',
        style: state.style,
        center: state.center,
        zoom: state.zoom,
        bearing: state.bearing,
        pitch: state.pitch,
        renderWorldCopies: false,
      });
      map.addControl(new maplibregl.NavigationControl(), 'top-left');
      if (state.projection === 'globe') {
        map.on('load', function () { map.setProjection({ type: 'globe' }); });
      }
    } catch (e) {
      if (el) el.innerHTML = '<p class="export-map-error">Could not render the saved map: ' +
        (e && e.message ? e.message : e) + '</p>';
    }
  })();
  </script>
</section>`;

    return { headTags, body };
}

/**
 * Render LLM-derived text to HTML for innerHTML insertion. The model can be
 * steered by anything it reads (dataset values, STAC descriptions), so its
 * output may carry attacker-controlled markup: scrub credential-shaped
 * tokens, parse markdown, then sanitize through DOMPurify. If either page
 * global is missing, fail closed to escaped plain text rather than raw HTML.
 *
 * @param {string} md
 * @returns {string} HTML safe to assign to innerHTML
 */
export function renderMarkdown(md) {
    const text = scrubCredentials(String(md ?? ''));
    if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
        return DOMPurify.sanitize(marked.parse(text));
    }
    if (!renderMarkdown._warned) {
        renderMarkdown._warned = true;
        console.warn('[ChatUI] marked and/or DOMPurify not loaded — chat text will render as escaped plain text. Check the CDN <script> tags in index.html.');
    }
    return `<pre>${escapeHtmlText(text)}</pre>`;
}

/** DOM-free HTML escape (renderMarkdown fallback path). */
function escapeHtmlText(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

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
     */
    constructor(agent, config, mount, mapManager = null) {
        this.agent = agent;
        this.config = config;
        this.mapManager = mapManager;
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

        // Export-to-HTML button (always shown)
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
            a.href = 'https://carbon-api.nrp-nautilus.io/';
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.className = 'footer-link carbon-link';
            a.title = 'Carbon dashboard — energy use for this deployment';
            a.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19.2 2.96a1 1 0 0 1 1.8.66c.4 5.85-1.18 12.96-9 16.4"/><path d="M2 21c0-3 1.85-5.36 5.08-6"/></svg>`;
            footer.prepend(a);
        }

        if (links.github) {
            const a = document.createElement('a');
            a.href = links.github;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.className = 'footer-link github-link';
            a.title = 'Source code';
            a.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;
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
        const footer = this.footerRightEl;
        if (!footer) return;

        const btn = document.createElement('button');
        btn.id = 'export-btn';
        btn.title = 'Save this conversation as a self-contained HTML document you can share or print.';
        btn.textContent = '💾';
        btn.disabled = true;

        btn.addEventListener('click', () => {
            if (btn.disabled) return;
            this.exportHtml();
        });

        footer.prepend(btn);
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

    /**
     * Build a self-contained HTML transcript of the current conversation
     * and trigger a download. Faithful mirror of the live chat panel,
     * with SQL rewritten for reproducibility and credential-shaped tokens
     * scrubbed.
     */
    exportHtml() {
        const clone = this.messagesEl.cloneNode(true);
        this._sanitizeExportClone(clone);

        const css = this._exportCss();
        const title = this._exportTitle();
        const appUrl = window.location.href;
        const appUrlAttr = this.escapeHtml(appUrl).replace(/"/g, '&quot;');
        const appTitle = document.title || 'GLEN';
        const exportedAt = new Date().toLocaleString();

        // Capture the final map state (one map per saved log). Guarded so a
        // ChatUI built without a map still exports the transcript.
        let mapState = null;
        try {
            mapState = this.mapManager?.getExportState?.() ?? null;
        } catch (err) {
            console.warn('[ChatUI] map capture for export failed:', err);
        }
        const mapEmbed = buildMapEmbedHtml(mapState);

        const html =
`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${this.escapeHtml(title)}</title>
<style>${css}</style>
${mapEmbed.headTags}
</head>
<body>
<header class="export-header">
  <h1>GLEN chat transcript</h1>
  <p>Exported ${this.escapeHtml(exportedAt)} — <a href="${appUrlAttr}">${this.escapeHtml(appTitle)}</a></p>
  <p class="export-note">SQL queries below have been rewritten to use the public S3 endpoint
     (<code>https://s3-west.nrp-nautilus.io/</code>) so they can be re-run from any DuckDB
     with the <code>httpfs</code> extension loaded.</p>
</header>
${mapEmbed.body}
<main id="chat-messages">${clone.innerHTML}</main>
</body>
</html>`;

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

    /**
     * Walk a cloned messagesEl subtree applying export-time transforms:
     * drop transient UI, rewrite SQL, scrub credentials.
     */
    _sanitizeExportClone(root) {
        // Drop transient interactive UI.
        root.querySelectorAll('.tool-approval-buttons, button, script')
            .forEach(el => el.remove());

        // Remove .running class from any rows still in-flight at click time.
        root.querySelectorAll('.running').forEach(el => el.classList.remove('running'));

        // SQL rewrite: only inside .language-sql code blocks.
        root.querySelectorAll('code.language-sql').forEach(codeEl => {
            const original = codeEl.textContent;
            const rewritten = rewriteS3UrlsInSql(original);
            // Replace text content; drop any prior syntax-highlight spans
            // (they reference the original token offsets and become stale).
            codeEl.className = 'language-sql';
            codeEl.textContent = rewritten;
        });

        // Credential scrub: DOM-wide on text nodes only.
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const toUpdate = [];
        let node = walker.nextNode();
        while (node) {
            const scrubbed = scrubCredentials(node.nodeValue);
            if (scrubbed !== node.nodeValue) toUpdate.push([node, scrubbed]);
            node = walker.nextNode();
        }
        for (const [n, v] of toUpdate) n.nodeValue = v;
    }

    _exportFilename() {
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
                      `-${pad(d.getHours())}${pad(d.getMinutes())}`;
        return `glen-chat-${stamp}.html`;
    }

    _exportTitle() {
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
                      `${pad(d.getHours())}:${pad(d.getMinutes())}`;
        return `GLEN chat — ${stamp}`;
    }

    /**
     * Inlined CSS subset for the export. Covers what's needed to render
     * messages, turn rows, tool calls, SQL/result <details>, and code
     * blocks. Excludes anything related to live input, layout, scrollbars,
     * or interactive buttons.
     */
    _exportCss() {
        return `
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
       max-width: 900px; margin: 1rem auto; padding: 0 1rem; color: #1a1a2e; line-height: 1.5; }
.export-header { border-bottom: 1px solid #ddd; padding-bottom: 0.75rem; margin-bottom: 1rem; }
.export-header h1 { margin: 0 0 0.25rem; font-size: 1.25rem; }
.export-header p { margin: 0.25rem 0; color: #555; font-size: 13px; }
.export-note { font-size: 12px; color: #6b7280; background: #f3f4f6;
               padding: 6px 10px; border-radius: 4px; }
.chat-message { padding: 8px 10px; margin: 6px 0; border-radius: 6px; font-size: 14px; }
.chat-message.user { background: #e0f2fe; }
.chat-message.assistant { background: #f9fafb; }
.chat-message.system { background: #fff7ed; color: #92400e; font-size: 12px; font-style: italic; }
.chat-message.error { background: #fef2f2; color: #991b1b; font-size: 12px; }
.chat-message pre { background: #1e293b; color: #e2e8f0; padding: 8px; border-radius: 4px;
                    overflow-x: auto; font-size: 12px; }
.chat-message code { background: rgba(0,0,0,0.05); padding: 1px 4px; border-radius: 3px;
                     font-size: 12px; }
.chat-message pre code { background: transparent; padding: 0; color: inherit; }
.chat-message table { border-collapse: collapse; margin: 6px 0; font-size: 12px; }
.chat-message th, .chat-message td { border: 1px solid #ddd; padding: 4px 8px; }
.chat-message th { background: #f3f4f6; }
.agent-turn { margin: 8px 0; border: 1px solid #e5e7eb; border-radius: 6px;
              padding: 4px 8px; }
.agent-turn > summary { cursor: pointer; font-size: 12px; color: #2c5282;
                        padding: 2px 4px; list-style: none; }
.agent-turn > summary::-webkit-details-marker { display: none; }
.agent-turn-row { font-size: 12px; margin: 2px 0; }
.agent-turn-row-summary { padding: 2px 6px; cursor: pointer; list-style: none;
                          display: flex; align-items: center; gap: 6px; color: #2c5282; }
.agent-turn-row-summary::-webkit-details-marker { display: none; }
.agent-turn-row-body { padding: 4px 10px 6px 24px; font-size: 12px; color: #1a1a2e; }
.tool-call-item, .tool-result-item { margin: 4px 0; }
.tool-call-item strong, .tool-result-item strong { font-weight: 600; color: #374151; }
.row-status.done { color: #28a745; font-weight: 600; }
.row-status.error { color: #dc3545; font-weight: 600; }
.sql-detail summary { cursor: pointer; color: #2c5282; font-size: 11px;
                      padding: 2px 0; list-style: none; }
.sql-detail summary::-webkit-details-marker { display: none; }
.sql-detail summary::before { content: '▸ '; }
.sql-detail[open] summary::before { content: '▾ '; }
.sql-detail pre { background: #1e293b; color: #e2e8f0; padding: 8px;
                  border-radius: 4px; overflow-x: auto; font-size: 11px;
                  white-space: pre-wrap; word-break: break-word; }
.tool-output { background: #f9fafb; padding: 6px; border-radius: 3px;
               font-size: 11px; white-space: pre-wrap; word-break: break-word;
               max-height: 400px; overflow-y: auto; }
.tool-tag { font-size: 10px; padding: 1px 5px; border-radius: 3px;
            background: #e5e7eb; color: #374151; margin-left: 4px; }
.tool-tag.remote { background: #dbeafe; color: #1e40af; }
.welcome-message { background: #f9fafb; padding: 8px 10px; border-radius: 6px;
                   font-size: 13px; color: #6b7280; }
.welcome-examples { display: none; }
.export-map-section { margin: 0 0 1rem; }
.export-map-title { font-size: 1rem; margin: 0 0 0.5rem; }
.export-map { width: 100%; height: 480px; border: 1px solid #ddd; border-radius: 6px; }
.export-map-note { font-size: 12px; color: #6b7280; margin: 6px 0 0; }
.export-map-error { padding: 1rem; color: #991b1b; font-size: 13px; }
`;
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
