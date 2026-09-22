/**
 * ChatUI - Thin UI shell for the chat interface.
 *
 * Owns all DOM manipulation. Consumes events from Agent.
 * Renders collapsible tool-call blocks (VSCode Copilot-inspired).
 */

import { CARBON_DASHBOARD_URL } from './app-header.js';
import { ensurePanelActions } from './panel-actions.js';
import { githubIcon, leafIcon } from './icons.js';

/**
 * Default public (anonymous) S3 endpoint for the exported setup block.
 * Mirrors the host that `dataset-catalog.js` strips when it converts asset
 * hrefs to `s3://` paths. Apps on other storage override it with
 * `public_s3_endpoint` in their config.
 */
export const PUBLIC_S3_ENDPOINT = 's3-west.nrp-nautilus.io';

/**
 * Strip a scheme and any trailing slashes from an S3 host, so a config that
 * spells the endpoint as a URL still produces a valid `ENDPOINT '…'`.
 *
 * @param {string} endpoint
 * @returns {string}
 */
function normalizeS3Host(endpoint) {
    return String(endpoint || PUBLIC_S3_ENDPOINT)
        .replace(/^https?:\/\//, '')
        .replace(/\/+$/, '');
}

/**
 * Resolve the app's export settings.
 *
 * Shape in `layers-input.json` (or the deploy-time `config.json`, which wins):
 *
 * ```json
 * "export": { "enabled": false }
 * "export": { "public_s3_endpoint": "minio.example.org" }
 * "export": false
 * ```
 *
 * Opt-*out*: absent config means the export is on, which is what the public
 * apps want. Private deployments turn it off, because the credential scrub
 * strips exactly what their exported queries would need — the recipient gets
 * a document whose code cannot run.
 *
 * `public_s3_endpoint` as a flat top-level key is the older spelling (#367)
 * and is still honoured, with the block winning when both are set.
 *
 * @param {object} [config] - merged app config
 * @returns {{ enabled: boolean, s3Endpoint: string }}
 */
export function resolveExportConfig(config = {}) {
    // Deploy-time config.json arrives from k8s, where a boolean can land as
    // the string "false"; treat both spellings as off.
    const isOff = (v) => v === false || v === 'false';

    const block = config?.export;
    const blk = (block && typeof block === 'object') ? block : {};
    const enabled = !isOff(block) && !isOff(blk.enabled);
    const endpoint = blk.public_s3_endpoint || config?.public_s3_endpoint || PUBLIC_S3_ENDPOINT;

    // Which language the exported document opens on. An unknown value falls
    // back to SQL rather than showing an empty document — the reader can
    // still switch in the file.
    const wanted = String(blk.default_code_language ?? 'sql').toLowerCase();
    const codeLanguage = CODE_LANGUAGES.some(l => l.id === wanted) ? wanted : 'sql';

    return { enabled, s3Endpoint: normalizeS3Host(endpoint), codeLanguage };
}

/**
 * DuckDB preamble that points `s3://` URLs at the public endpoint
 * anonymously, so every query in an exported transcript re-runs verbatim
 * outside the cluster.
 *
 * We emit this instead of rewriting `s3://bucket/key` to an HTTPS URL: the
 * paths the catalog hands the model are routinely globs
 * (`s3://bucket/hex/x/h0=*\/data_0.parquet`, `.../**`), and `httpfs` cannot
 * expand a glob over plain HTTP — there is no listing. Under a configured
 * S3 secret DuckDB lists via the S3 API and the glob resolves.
 *
 * Deliberately credential-free: an omitted KEY_ID/SECRET means unsigned
 * requests, which is what public buckets want, and keeps the block clear of
 * {@link scrubCredentials}' `SECRET '…'` pattern.
 *
 * @param {string} [endpoint] - S3 host, no scheme
 * @returns {string} SQL to run once before the transcript's queries
 */
export function buildDuckdbSetupSql(endpoint = PUBLIC_S3_ENDPOINT) {
    const host = normalizeS3Host(endpoint);
    return `INSTALL httpfs; LOAD httpfs;

CREATE OR REPLACE SECRET public_s3 (
    TYPE s3,
    PROVIDER config,
    ENDPOINT '${host}',
    URL_STYLE 'path',
    USE_SSL true
);`;
}

/**
 * Code languages the export can present. SQL is what actually ran; R and
 * Python are thin wrappers around the identical query text, because most of
 * our users can drive R or Python and cannot write SQL — they just don't know
 * that `duckdb` hands SQL straight through in three lines.
 */
export const CODE_LANGUAGES = [
    { id: 'sql', label: 'SQL' },
    { id: 'r', label: 'R' },
    { id: 'python', label: 'Python' },
];

/**
 * Quote SQL as an R raw string, so nothing inside it needs escaping. Walks
 * R's delimiter forms in turn; only a query containing every closing form
 * falls back to an escaped ordinary string. Raw strings need R >= 4.0.
 *
 * @param {string} sql
 * @returns {string} an R string literal
 */
function rRawString(sql) {
    const forms = [['r"(', ')"'], ['r"[', ']"'], ['r"{', '}"'], ['r"---(', ')---"']];
    for (const [open, close] of forms) {
        if (!sql.includes(close)) return `${open}\n${sql}\n${close}`;
    }
    return `"${sql.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Quote SQL as a Python triple-quoted raw string. Raw so a backslash in the
 * query (a regex, say) survives verbatim; the newline before the closing
 * delimiter keeps a trailing backslash legal. Falls back to an escaped
 * literal only if the query contains both triple-quote forms.
 *
 * @param {string} sql
 * @returns {string} a Python string literal
 */
function pyString(sql) {
    for (const q of ['"""', "'''"]) {
        if (!sql.includes(q)) return `r${q}\n${sql}\n${q}`;
    }
    return JSON.stringify(sql);
}

/**
 * The connect-and-configure preamble for one language: load `httpfs` and
 * point `s3://` at the public endpoint anonymously (see
 * {@link buildDuckdbSetupSql} for why the export configures the endpoint
 * rather than rewriting the URLs).
 *
 * @param {string} lang - 'sql' | 'r' | 'python'
 * @param {string} [endpoint]
 * @returns {string}
 */
export function buildSetupSnippet(lang, endpoint = PUBLIC_S3_ENDPOINT) {
    const host = normalizeS3Host(endpoint);
    const secret =
        `CREATE OR REPLACE SECRET public_s3 (TYPE s3, PROVIDER config, ` +
        `ENDPOINT '${host}', URL_STYLE 'path', USE_SSL true);`;

    if (lang === 'r') {
        return `# install.packages("duckdb")        # first time only
library(duckdb)

con <- dbConnect(duckdb())
# invisible() keeps dbExecute's row count from printing at the console
invisible(dbExecute(con, "INSTALL httpfs; LOAD httpfs;"))
invisible(dbExecute(con, "${secret}"))`;
    }

    if (lang === 'python') {
        return `# pip install duckdb pandas          # first time only
import duckdb

con = duckdb.connect()
con.execute("INSTALL httpfs; LOAD httpfs;")
con.execute("${secret}")`;
    }

    return buildDuckdbSetupSql(host);
}

/**
 * Wrap one query for a language, around byte-identical SQL. The wrapper is
 * presentation only: change the query text and the export stops being a
 * record of what ran.
 *
 * @param {string} sql
 * @param {string} lang - 'sql' | 'r' | 'python'
 * @returns {string}
 */
export function wrapQuery(sql, lang) {
    const body = String(sql ?? '').replace(/\s+$/, '');
    if (lang === 'r') return `df <- dbGetQuery(con, ${rRawString(body)})`;
    if (lang === 'python') return `df = con.sql(${pyString(body)}).df()`;
    return body;
}

/**
 * Inline script for the exported document: the language toggle. Kept as a
 * literal rather than built from `wrapQuery` logic, because every variant is
 * already rendered into the file — this only flips which one shows, and
 * remembers the choice for the next file the reader opens.
 */
const EXPORT_CODE_LANG_SCRIPT = `<script>
(function () {
  var KEY = 'glen-export-code-lang';
  var strip = document.querySelector('.code-lang-toggle');
  if (!strip) return;
  function apply(lang) {
    document.body.setAttribute('data-code-lang', lang);
    var btns = strip.querySelectorAll('button[data-set-lang]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute('aria-pressed', String(btns[i].getAttribute('data-set-lang') === lang));
    }
    try { localStorage.setItem(KEY, lang); } catch (e) {}
  }
  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) {}
  if (saved && strip.querySelector('button[data-set-lang="' + saved + '"]')) apply(saved);
  strip.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('button[data-set-lang]') : null;
    if (b) apply(b.getAttribute('data-set-lang'));
  });
})();
<\/script>`;

/**
 * Inline script for the exported document: printing. Two jobs — the report /
 * full choice, and opening collapsed `<details>` for the print run.
 *
 * The second one is not cosmetic: every query and result in the transcript
 * lives in a `<details>`, and a closed one prints empty, so a naive
 * print-to-PDF silently drops the analysis. Bound to the print events rather
 * than to our own button, because most people press Ctrl+P.
 */
const EXPORT_PRINT_SCRIPT = `<script>
(function () {
  var check = document.getElementById('export-report-style');
  if (check) {
    check.addEventListener('change', function () {
      document.body.setAttribute('data-print', check.checked ? 'report' : 'full');
    });
  }
  var reopened = [];
  window.addEventListener('beforeprint', function () {
    reopened = [];
    var closed = document.querySelectorAll('details:not([open])');
    for (var i = 0; i < closed.length; i++) { reopened.push(closed[i]); closed[i].open = true; }
  });
  window.addEventListener('afterprint', function () {
    for (var i = 0; i < reopened.length; i++) reopened[i].open = false;
    reopened = [];
  });
  var btn = document.querySelector('.export-print-btn');
  if (btn) btn.addEventListener('click', function () { window.print(); });
})();
<\/script>`;

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
 * The section also carries the embed affordance: a recipient who wants this
 * map on their own site gets the iframe snippet and plain-language steps, and
 * `#map` strips the page to the map alone so one file serves both the
 * transcript and the embed.
 *
 * @param {object|null} state - from MapManager.getExportState(); null/empty → no map
 * @param {{filename?: string}} [options] - the download's own filename, used in the snippet
 * @returns {{ headTags: string, body: string }} empty strings when there is no map
 */
export function buildMapEmbedHtml(state, options = {}) {
    if (!state || !state.style) return { headTags: '', body: '' };

    const filename = options.filename || 'this-file.html';
    const safeName = escapeHtmlText(filename);

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

    // The snippet a recipient pastes into their own page. `#map` is what makes
    // one file serve two purposes — see the view-mode script below.
    const snippet =
`<iframe src="${safeName}#map" width="100%" height="480"
        style="border:0" loading="lazy" title="Map"></iframe>`;

    const body =
`<section class="export-map-section">
  <h2 class="export-map-title">Map at time of export</h2>
  <div id="export-map" class="export-map"></div>
  <p class="export-map-note">Interactive map re-rendered from the saved state. Needs a network
     connection to the original public tile sources; private or signed layers may not appear.</p>
  <div class="export-embed">
    <button type="button" class="export-embed-toggle" aria-expanded="false"
            aria-controls="export-embed-help">Embed this map on your website</button>
    <div class="export-embed-help" id="export-embed-help" hidden>
      <p>This map can go on your own website. It is one self-contained file — no server, no
         account, no build step.</p>
      <ol>
        <li>Send this file (<code>${safeName}</code>) to whoever looks after your website and
            ask them to upload it. Any web host will do.</li>
        <li>Ask them to paste this where the map should appear:
          <pre class="export-embed-snippet"><code>${escapeHtmlText(snippet)}</code></pre>
          <button type="button" class="export-embed-copy">Copy snippet</button>
        </li>
        <li>If they put the file somewhere other than beside that page, they will need to change
            <code>src</code> to wherever it ended up.</li>
      </ol>
      <p class="export-embed-note">The <code>#map</code> on the end shows the map by itself,
         without this transcript — <a href="#map">open that view</a> to see what a visitor gets.
         Drop the <code>#map</code> to embed the whole page instead. Either way the map draws its
         tiles from the same public sources it came from, so the page needs a network connection,
         and private or signed layers will not appear.</p>
    </div>
  </div>
  <script type="application/json" id="export-map-state">${safeJson}</script>
  <script>
  (function () {
    var el = document.getElementById('export-map');
    var map = null;
    try {
      if (typeof maplibregl === 'undefined') throw new Error('MapLibre GL JS did not load');
      var state = JSON.parse(document.getElementById('export-map-state').textContent);
      if (window.pmtiles && maplibregl.addProtocol) {
        maplibregl.addProtocol('pmtiles', new pmtiles.Protocol().tile);
      }
      map = new maplibregl.Map({
        container: 'export-map',
        style: state.style,
        center: state.center,
        zoom: state.zoom,
        bearing: state.bearing,
        pitch: state.pitch,
        renderWorldCopies: false,
        preserveDrawingBuffer: true,
      });
      map.addControl(new maplibregl.NavigationControl(), 'top-left');
      if (state.projection === 'globe') {
        map.on('load', function () { map.setProjection({ type: 'globe' }); });
      }
    } catch (e) {
      if (el) el.innerHTML = '<p class="export-map-error">Could not render the saved map: ' +
        (e && e.message ? e.message : e) + '</p>';
    }

    // View mode: '#map' strips the page to the map alone, which is what the
    // embed snippet points an iframe at. Same file, two presentations.
    function applyView() {
      var mapOnly = window.location.hash === '#map';
      document.body.setAttribute('data-view', mapOnly ? 'map' : 'full');
      if (map) map.resize();
    }
    applyView();
    window.addEventListener('hashchange', applyView);

    var toggle = document.querySelector('.export-embed-toggle');
    var help = document.getElementById('export-embed-help');
    if (toggle && help) {
      toggle.addEventListener('click', function () {
        var opening = help.hasAttribute('hidden');
        if (opening) help.removeAttribute('hidden');
        else help.setAttribute('hidden', '');
        toggle.setAttribute('aria-expanded', String(opening));
      });
    }

    var copyBtn = document.querySelector('.export-embed-copy');
    var snippetEl = document.querySelector('.export-embed-snippet code');
    if (copyBtn && snippetEl) {
      copyBtn.addEventListener('click', function () {
        function settle(label) {
          copyBtn.textContent = label;
          setTimeout(function () { copyBtn.textContent = 'Copy snippet'; }, 2000);
        }
        // Selecting the text is the fallback: clipboard access is refused on
        // file:// in some browsers, which is exactly how this file gets opened.
        function selectInstead() {
          try {
            var range = document.createRange();
            range.selectNodeContents(snippetEl);
            var sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            settle('Selected — press Ctrl+C');
          } catch (err) { settle('Copy by hand'); }
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(snippetEl.textContent)
            .then(function () { settle('Copied'); }, selectInstead);
        } else selectInstead();
      });
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
        // Export settings (opt-out + endpoint), resolved once — initExportButton
        // needs them before any DOM is built.
        this.exportConfig = resolveExportConfig(config);
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
        btn.textContent = row ? '\u{1F4BE} Export Map' : '\u{1F4BE}';
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
     * and trigger a download. Faithful mirror of the live chat panel: SQL is
     * carried verbatim under a DuckDB setup block that makes it re-runnable,
     * and credential-shaped tokens are scrubbed.
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
        const mapEmbed = buildMapEmbedHtml(mapState, { filename: this._exportFilename() });

        // Setup block: the SQL in the transcript is left untouched (globs and all),
        // so the export carries the preamble that makes those paths resolve.
        const exportCfg = this.exportConfig || resolveExportConfig(this.config);
        const setupHost = exportCfg.s3Endpoint;
        const codeLang = exportCfg.codeLanguage;

        // One setup block per language, one visible at a time (§3 of #368).
        const setupBlocks = CODE_LANGUAGES.map(l =>
            `<pre class="code-variant" data-lang="${l.id}"><code class="language-${l.id}">` +
            `${this.escapeHtml(buildSetupSnippet(l.id, setupHost))}</code></pre>`
        ).join('\n  ');

        const langButtons = CODE_LANGUAGES.map(l =>
            `<button type="button" data-set-lang="${l.id}" ` +
            `aria-pressed="${l.id === codeLang}">${this.escapeHtml(l.label)}</button>`
        ).join('');

        const html =
`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${this.escapeHtml(title)}</title>
<style>${css}</style>
${mapEmbed.headTags}
</head>
<body data-code-lang="${codeLang}" data-print="full">
<header class="export-header">
  <h1>GLEN chat transcript</h1>
  <p>Exported ${this.escapeHtml(exportedAt)} — <a href="${appUrlAttr}">${this.escapeHtml(appTitle)}</a></p>
  <p class="export-note">The queries below are the ones the agent ran, verbatim. To re-run them
     outside the cluster, run the setup block first; it points <code>s3://</code> paths at the
     public endpoint (<code>${this.escapeHtml(setupHost)}</code>) with anonymous access.</p>
  <div class="export-controls">
    <div class="code-lang-toggle" role="group" aria-label="Show code as">
      <span class="code-lang-label">Show code as</span>${langButtons}
    </div>
    <div class="export-print-controls">
      <label class="export-print-report"><input type="checkbox" id="export-report-style">
        Report style — print without code</label>
      <button type="button" class="export-print-btn">Print / Save as PDF</button>
    </div>
  </div>
</header>
<section class="export-setup">
  <h2 class="export-setup-title">Run this first</h2>
  ${setupBlocks}
  <p class="export-setup-note">One time per session, then every query in this transcript runs as
     written. Public buckets only — private data is not reachable this way.</p>
</section>
${mapEmbed.body}
<main id="chat-messages">${clone.innerHTML}</main>
${EXPORT_CODE_LANG_SCRIPT}
${EXPORT_PRINT_SCRIPT}
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
     * drop transient UI, flatten SQL highlighting, scrub credentials.
     */
    _sanitizeExportClone(root) {
        // Drop transient interactive UI.
        root.querySelectorAll('.tool-approval-buttons, button, script')
            .forEach(el => el.remove());

        // Remove .running class from any rows still in-flight at click time.
        root.querySelectorAll('.running').forEach(el => el.classList.remove('running'));

        // Each SQL block becomes one block per language: the same query,
        // wrapped for R or Python, with only one visible at a time. The SQL
        // itself is exported verbatim — s3:// paths included, since the setup
        // block in the header makes them resolve — and building the variants
        // through the DOM also flattens stale highlight spans.
        const doc = root.ownerDocument || document;
        root.querySelectorAll('pre > code.language-sql').forEach(codeEl => {
            const sql = codeEl.textContent;
            const variants = doc.createElement('div');
            variants.className = 'code-variants';
            for (const lang of CODE_LANGUAGES) {
                const pre = doc.createElement('pre');
                pre.className = 'code-variant';
                pre.setAttribute('data-lang', lang.id);
                const code = doc.createElement('code');
                code.className = `language-${lang.id}`;
                code.textContent = wrapQuery(sql, lang.id);
                pre.appendChild(code);
                variants.appendChild(pre);
            }
            codeEl.parentElement.replaceWith(variants);
        });

        // The collapsed row says "SQL" in the live chat, where SQL is all it
        // can be; in the export it may be showing R or Python.
        root.querySelectorAll('details.sql-detail > summary').forEach(sum => {
            if (sum.textContent.trim() === 'SQL') sum.textContent = 'Query';
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
.export-controls { display: flex; flex-wrap: wrap; align-items: center;
                   justify-content: space-between; gap: 8px; margin: 8px 0 0; }
.export-print-controls { display: flex; align-items: center; gap: 8px; font-size: 12px;
                         color: #6b7280; }
.export-print-report { display: flex; align-items: center; gap: 4px; cursor: pointer; }
.export-print-btn { font: inherit; font-size: 12px; padding: 2px 10px; cursor: pointer;
                    border: 1px solid #d1d5db; border-radius: 4px; background: #fff;
                    color: #374151; }
.code-lang-toggle { display: flex; align-items: center; gap: 6px; margin: 0; }
.code-lang-label { font-size: 12px; color: #6b7280; }
.code-lang-toggle button { font: inherit; font-size: 12px; padding: 2px 10px; cursor: pointer;
                           border: 1px solid #d1d5db; border-radius: 4px; background: #fff;
                           color: #374151; }
.code-lang-toggle button[aria-pressed="true"] { background: #2c5282; border-color: #2c5282;
                                                color: #fff; }
.code-variant { display: none; }
body[data-code-lang="sql"] .code-variant[data-lang="sql"],
body[data-code-lang="r"] .code-variant[data-lang="r"],
body[data-code-lang="python"] .code-variant[data-lang="python"] { display: block; }
.export-setup { margin: 0 0 1rem; border: 1px solid #e5e7eb; border-radius: 6px;
                padding: 8px 10px; }
.export-setup-title { font-size: 1rem; margin: 0 0 0.5rem; }
.export-setup .code-variant { background: #1e293b; color: #e2e8f0; padding: 8px; border-radius: 4px;
                    overflow-x: auto; font-size: 12px; }
.export-setup-note { font-size: 12px; color: #6b7280; margin: 6px 0 0; }
.export-map-section { margin: 0 0 1rem; }
.export-map-title { font-size: 1rem; margin: 0 0 0.5rem; }
.export-map { width: 100%; height: 480px; border: 1px solid #ddd; border-radius: 6px; }
.export-map-note { font-size: 12px; color: #6b7280; margin: 6px 0 0; }
.export-map-error { padding: 1rem; color: #991b1b; font-size: 13px; }
.export-embed { margin: 8px 0 0; }
.export-embed-toggle { font: inherit; font-size: 12px; padding: 4px 10px; cursor: pointer;
                       border: 1px solid #d1d5db; border-radius: 4px; background: #fff;
                       color: #2c5282; }
.export-embed-toggle[aria-expanded="true"] { background: #eef2ff; border-color: #c7d2fe; }
.export-embed-help { border: 1px solid #e5e7eb; border-radius: 6px; padding: 10px 12px;
                     margin: 8px 0 0; font-size: 13px; background: #f9fafb; }
.export-embed-help ol { margin: 8px 0; padding-left: 20px; }
.export-embed-help li { margin: 6px 0; }
.export-embed-snippet { background: #1e293b; color: #e2e8f0; padding: 8px; border-radius: 4px;
                        overflow-x: auto; font-size: 11px; white-space: pre-wrap;
                        word-break: break-word; margin: 6px 0; }
.export-embed-copy { font: inherit; font-size: 11px; padding: 2px 8px; cursor: pointer;
                     border: 1px solid #d1d5db; border-radius: 4px; background: #fff;
                     color: #374151; }
.export-embed-note { font-size: 12px; color: #6b7280; margin: 8px 0 0; }

/* '#map' view: the same file, stripped to the map, which is what the embed
   snippet points an iframe at. */
body[data-view="map"] { margin: 0; padding: 0; max-width: none; }
body[data-view="map"] > *:not(.export-map-section) { display: none !important; }
body[data-view="map"] .export-map-title,
body[data-view="map"] .export-map-note,
body[data-view="map"] .export-embed { display: none; }
body[data-view="map"] .export-map-section { margin: 0; }
body[data-view="map"] .export-map { height: 100vh; border: 0; border-radius: 0; }

/* Print: the export is a document people hand to a board or a funder, so
   printing it has to come out as a document. */
@media print {
  body { max-width: none; margin: 0; padding: 0; }
  .export-controls, .export-embed { display: none !important; }
  .export-header { border-bottom: 1px solid #999; }
  a { color: inherit; text-decoration: none; }
  /* Never split a query, a result or a turn across a page. */
  .agent-turn, .agent-turn-row, .tool-call-item, .tool-result-item,
  .sql-detail, .code-variants, pre, .export-setup,
  .export-map-section, .chat-message { break-inside: avoid; }
  /* Screen scroll boxes become full text on paper. */
  .tool-output { max-height: none; overflow: visible; }
  .export-map { height: 420px; }
  .agent-turn > summary, .agent-turn-row-summary, .sql-detail summary { color: #444; }
  /* Report style: the prose, the answers and the map — none of the machinery. */
  body[data-print="report"] .agent-turn,
  body[data-print="report"] .export-setup { display: none !important; }
}
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
