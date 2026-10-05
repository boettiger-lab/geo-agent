/**
 * The exported session report (#388): a self-contained HTML document that
 * reads like a Quarto / R Markdown report — one section per question, the
 * queries the agent ran as folded code chunks with their output beneath, the
 * model's answer as prose, and the full unedited call log as an appendix.
 *
 * Everything here is DOM-free string building, so the whole document is
 * testable without a browser. ChatUI records the session as it happens
 * (see `ChatUI#_recordTurn` and friends) and hands that record to
 * {@link buildReportHtml}.
 */

/**
 * Where the disclosure's "GLEN" link points: the project's deployed page,
 * not its GitHub repo. Apps override it with `export.project_url`.
 */
export const GLEN_PROJECT_URL = 'https://boettiger-lab.github.io/geo-agent/';

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
 * "export": { "project_url": "https://glen.example.org/" }
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
 * @returns {{ enabled: boolean, s3Endpoint: string, codeLanguage: string, projectUrl: string }}
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

    const projectUrl = blk.project_url || GLEN_PROJECT_URL;

    return { enabled, s3Endpoint: normalizeS3Host(endpoint), codeLanguage, projectUrl };
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
    // The session log stays folded: printed open, it is most of the paper.
    var closed = document.querySelectorAll('details:not([open]):not([data-print-closed])');
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

/* ------------------------------------------------------------------ */
/*  The session record → the report                                   */
/* ------------------------------------------------------------------ */

/*
 * Shape of the record ChatUI accumulates (one entry per user message):
 *
 *   { turns: [{
 *       prompt:    string,                      // the user's words, verbatim
 *       model:     { id, label } | null,        // selected when the turn began
 *       startedAt: ISO string,
 *       status:    'done' | 'error' | 'cancelled' | 'running',
 *       steps:     [{ name, args, success, source, result, sqlQuery? }],
 *       answer:    markdown | null,              // the model's final prose
 *       notes:     [{ role, text }],             // system / error lines
 *   }] }
 */

/**
 * Calls that only look something up for the model — catalog and schema
 * reads, status polls. They shape the analysis but are not part of it, so
 * the report body names them in one line and the appendix keeps them whole.
 */
export const CONSULT_TOOLS = new Set([
    'get_schema', 'list_datasets', 'get_map_state', 'browse_stac_catalog',
    'get_collection', 'get_stac_details', 'get_hex_tile_status', 'get_user_location',
]);

/**
 * The SQL a step carried, if any. Remote tools name it `sql_query` or
 * `query` (the same rule the registry uses for `sqlQuery`); local tools
 * (`render_chart`, `filter_by_query`) name it `sql`. A local `query` arg is
 * not SQL — `geocode` uses it for a place name.
 *
 * @param {object} step
 * @returns {string|null}
 */
export function stepSql(step) {
    const a = (step && typeof step.args === 'object' && step.args) || {};
    const pick = (...vals) => vals.find(v => typeof v === 'string' && v.trim()) || null;
    if (step?.source === 'remote') return pick(step.sqlQuery, a.sql_query, a.query);
    return pick(a.sql, step?.sqlQuery);
}

/**
 * Whether a step failed. Mirrors `Agent#_isFailedResult`: a registry error,
 * an `Error…` string, or a tool's `{"success": false}` envelope — the
 * registry marks `success: true` whenever the tool didn't throw.
 */
export function isFailedStep(step) {
    if (!step) return false;
    if (step.success === false || step.source === 'error') return true;
    const s = typeof step.result === 'string' ? step.result : '';
    return /^\s*Error\b/.test(s) || /"success"\s*:\s*false/.test(s);
}

/**
 * Where a step goes in the report body.
 *
 *   'chunk'    — carried SQL, or drew a chart: a chunk, with its output
 *   'map'      — a map action: its effect is the map, so a one-line note
 *   'consult'  — a lookup: named in the section's "Consulted" line
 *   'failed'   — counted, and left to the session log
 *
 * @param {object} step
 * @returns {'chunk'|'map'|'consult'|'failed'}
 */
export function classifyStep(step) {
    if (isFailedStep(step)) return 'failed';
    if (stepSql(step) || step.name === 'render_chart') return 'chunk';
    if (CONSULT_TOOLS.has(step.name) || step.source === 'remote') return 'consult';
    return 'map';
}

/**
 * The GLEN build this page was loaded from, read off the module's own URL:
 * downstream apps load `…/gh/boettiger-lab/geo-agent@<ref>/app/…` from
 * jsDelivr, so the pin is right there. Null for a local or preview build.
 *
 * @param {string} [url]
 * @returns {string|null} a tag (`v3.28.0`) or commit SHA
 */
export function libraryVersion(url = import.meta.url) {
    const m = /\/geo-agent@([^/]+)\/app\//.exec(String(url || ''));
    return m ? m[1] : null;
}

/**
 * The `chart_id` a successful render_chart step returned, which keys its
 * figure in {@link buildReportHtml}'s `figures`.
 *
 * @param {object} step
 * @returns {string|null}
 */
export function chartIdOf(step) {
    if (step?.name !== 'render_chart' || isFailedStep(step)) return null;
    try {
        return JSON.parse(step.result)?.chart_id || null;
    } catch {
        return null;
    }
}

/** The distinct models a session used, in order of first use. */
export function sessionModels(record) {
    const seen = new Map();
    for (const t of record?.turns || []) {
        if (t.model?.id && !seen.has(t.model.id)) seen.set(t.model.id, t.model);
    }
    return [...seen.values()];
}

const OUTPUT_TABLE_ROWS = 20;

/**
 * Output for one chunk. A `query` result is the table it returned (a
 * markdown table renders as one; anything else stays preformatted). Other
 * SQL-carrying tools say what the rows became, since their output is the
 * map or a chart rather than a table.
 */
function chunkOutputHtml(step, renderMd, figures) {
    const result = scrubCredentials(String(step.result ?? ''));
    if (step.name === 'register_hex_tiles') {
        return `<p class="chunk-effect">→ Rendered on the map as hex tiles.</p>`;
    }
    if (step.name === 'filter_by_query') {
        return `<p class="chunk-effect">→ Used to filter the map.</p>`;
    }
    if (step.name === 'render_chart') return chartOutputHtml(step, figures);
    const lines = result.replace(/\s+$/, '').split('\n');
    const isMdTable = lines.length >= 2 && /^\s*\|/.test(lines[0]) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[1]);
    if (isMdTable) {
        const body = lines.filter(l => /^\s*\|/.test(l));
        const rows = body.length - 2;
        const shown = body.slice(0, 2 + OUTPUT_TABLE_ROWS).join('\n');
        const more = rows > OUTPUT_TABLE_ROWS
            ? `<p class="chunk-more">Showing the first ${OUTPUT_TABLE_ROWS} of ${rows} rows.</p>` : '';
        return `<div class="chunk-output">${renderMd(shown)}${more}</div>`;
    }
    return `<pre class="chunk-output"><code>${escapeHtmlText(result)}</code></pre>`;
}

/**
 * A chart's output: the figure, re-drawn by ChartRenderer at export time,
 * captioned with its title — and, when the model passed rows inline rather
 * than SQL, a line saying so, since there is no query above it to re-run.
 */
function chartOutputHtml(step, figures) {
    const a = step.args || {};
    const title = a.title ? escapeHtmlText(a.title) : `${escapeHtmlText(a.chart_type || '')} chart`;
    const id = chartIdOf(step);
    const svg = id && figures?.get(id);
    const inline = !stepSql(step) && Array.isArray(a.data)
        ? ` Plotted from ${a.data.length} row${a.data.length === 1 ? '' : 's'} the model passed inline (listed in the <a href="#session-log">session log</a>).`
        : '';
    if (!svg) {
        return `<p class="chunk-effect">→ Plotted as a chart: ${title}. The figure could not be carried into this export.${inline}</p>`;
    }
    return `<figure class="chunk-figure">${svg}<figcaption>${title}.${inline}</figcaption></figure>`;
}

/** One code variant per language, only the chosen one visible. */
function codeVariantsHtml(sql) {
    return '<div class="code-variants">' + CODE_LANGUAGES.map(l =>
        `<pre class="code-variant" data-lang="${l.id}"><code class="language-${l.id}">` +
        `${escapeHtmlText(scrubCredentials(wrapQuery(sql, l.id)))}</code></pre>`
    ).join('') + '</div>';
}

/** A folded code chunk, with its output beneath it. */
function chunkHtml(step, renderMd, figures) {
    const sql = stepSql(step);
    const code = sql
        ? `<details class="chunk-code"><summary>Code <span class="chunk-tool">${escapeHtmlText(step.name)}</span></summary>${codeVariantsHtml(sql)}</details>`
        : '';
    return `<div class="chunk" data-tool="${escapeHtmlText(step.name)}">
${code}
${chunkOutputHtml(step, renderMd, figures)}
</div>`;
}

/** One-line description of a map action, from its name and key argument. */
function describeMapStep(step) {
    const a = step.args || {};
    const target = a.display_name || a.title || a.layer_id || a.layer || '';
    const verb = String(step.name).replace(/_/g, ' ');
    return target ? `${verb}: ${target}` : verb;
}

/** "Consulted" summary: schemas by dataset, other lookups by tool (×n). */
function consultedHtml(steps) {
    const datasets = [];
    const tools = new Map();
    for (const s of steps) {
        const ds = s.name === 'get_schema' && s.args?.dataset_id;
        if (ds) { if (!datasets.includes(ds)) datasets.push(ds); }
        else tools.set(s.name, (tools.get(s.name) || 0) + 1);
    }
    const parts = [];
    if (datasets.length) {
        parts.push('schemas for ' + datasets.map(d => `<code>${escapeHtmlText(d)}</code>`).join(', '));
    }
    for (const [name, n] of tools) {
        parts.push(`<code>${escapeHtmlText(name)}</code>${n > 1 ? ` ×${n}` : ''}`);
    }
    return parts.length ? `<p class="report-consulted">Consulted ${parts.join('; ')}.</p>` : '';
}

function modelName(model) {
    if (!model?.id) return 'an unrecorded model';
    return model.label && model.label !== model.id
        ? `${escapeHtmlText(model.label)} (<code>${escapeHtmlText(model.id)}</code>)`
        : `<code>${escapeHtmlText(model.id)}</code>`;
}

function formatDate(iso) {
    const d = iso ? new Date(iso) : null;
    if (!d || isNaN(d)) return '';
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

/** Short heading text for the table of contents. */
function tocLabel(prompt, max = 64) {
    const p = scrubCredentials(String(prompt || '')).replace(/\s+/g, ' ').trim();
    return p.length > max ? p.slice(0, max - 1).trimEnd() + '…' : p;
}

/** One report section: the question, its chunks in order, then the answer. */
function sectionHtml(turn, i, renderMd, multiModel, figures) {
    const steps = turn.steps || [];
    const consulted = [];
    let failed = 0;
    const body = [];
    for (const step of steps) {
        const kind = classifyStep(step);
        if (kind === 'chunk') body.push(chunkHtml(step, renderMd, figures));
        else if (kind === 'map') body.push(`<p class="report-map-step">Map — ${escapeHtmlText(describeMapStep(step))}</p>`);
        else if (kind === 'consult') consulted.push(step);
        else failed++;
    }

    const meta = [];
    if (multiModel && turn.model?.id) meta.push(modelName(turn.model));
    if (steps.length) meta.push(`${steps.length} tool call${steps.length === 1 ? '' : 's'}`);
    if (failed) meta.push(`${failed} failed or retried, omitted here — see the <a href="#session-log-${i + 1}">session log</a>`);

    // Errors stay with their question; system chatter (retries) is left to
    // the session log. Lines from before the question set its context.
    const note = (n) =>
        `<p class="report-note ${escapeHtmlText(n.role)}">${escapeHtmlText(scrubCredentials(n.text))}</p>`;
    const context = (turn.context || []).map(note).join('\n');
    const notes = (turn.notes || []).filter(n => n.role === 'error').map(note).join('\n');
    const status = turn.status === 'cancelled' ? '<p class="report-note">This question was cancelled before an answer.</p>'
        : (turn.status === 'error' && !turn.answer) ? '<p class="report-note error">This question ended in an error.</p>' : '';

    return `<section class="report-section" id="q-${i + 1}">
<h2><span class="q-num">${i + 1}.</span> ${escapeHtmlText(scrubCredentials(turn.prompt || ''))}</h2>
${meta.length ? `<p class="report-meta">${meta.join(' · ')}</p>` : ''}
${context}
${consultedHtml(consulted)}
${body.join('\n')}
${turn.answer ? `<div class="report-prose">${renderMd(turn.answer)}</div>` : ''}
${notes}
${status}
</section>`;
}

const LOG_RESULT_CHARS = 4000;

/** The appendix: every call, unedited, collapsed per question. */
function sessionLogHtml(record) {
    const turns = (record.turns || []).filter(t => (t.steps || []).length);
    if (!turns.length) return '';
    const items = (record.turns || []).map((t, i) => {
        const steps = t.steps || [];
        if (!steps.length) return '';
        const logNotes = (t.notes || []).map(n =>
            `<p class="log-note">${escapeHtmlText(n.role)}: ${escapeHtmlText(scrubCredentials(n.text))}</p>`).join('\n');
        const calls = steps.map(s => {
            const args = (s.args && typeof s.args === 'object')
                ? Object.fromEntries(Object.entries(s.args).filter(([k]) => !REDACTED_KEYS.includes(k)))
                : s.args;
            let result = scrubCredentials(String(s.result ?? ''));
            if (result.length > LOG_RESULT_CHARS) result = result.slice(0, LOG_RESULT_CHARS) + '\n… (truncated in the export)';
            const mark = isFailedStep(s) ? '✗' : '✓';
            return `<div class="log-call${isFailedStep(s) ? ' failed' : ''}">
<p class="log-call-name">${mark} <code>${escapeHtmlText(s.name)}</code>${s.source === 'remote' ? ' <span class="log-tag">MCP</span>' : ''}</p>
<pre class="log-args"><code>${escapeHtmlText(scrubCredentials(JSON.stringify(args, null, 2) ?? ''))}</code></pre>
<pre class="log-result"><code>${escapeHtmlText(result)}</code></pre>
</div>`;
        }).join('\n');
        return `<details class="log-turn" id="session-log-${i + 1}" data-print-closed>
<summary>${i + 1}. ${escapeHtmlText(tocLabel(t.prompt, 80))} — ${steps.length} call${steps.length === 1 ? '' : 's'}</summary>
${calls}
${logNotes}
</details>`;
    }).join('\n');
    return `<section class="report-appendix" id="session-log">
<h2>Session log</h2>
<p class="report-appendix-note">Every tool call the agent made, in order, with its arguments and result — including the lookups and failed attempts the sections above leave out. Credentials are scrubbed; long results are cut.</p>
${items}
</section>`;
}

/**
 * Build the exported report.
 *
 * @param {{turns: object[]}} record - the session, as ChatUI recorded it
 * @param {object} opts
 * @param {string} [opts.appTitle]
 * @param {string} [opts.appUrl]
 * @param {Date}   [opts.exportedAt]
 * @param {string} [opts.title] - the document <title>
 * @param {string} [opts.s3Endpoint]
 * @param {string} [opts.codeLanguage]
 * @param {string} [opts.projectUrl]
 * @param {string|null} [opts.version] - GLEN build, from {@link libraryVersion}
 * @param {{headTags: string, body: string}} [opts.mapEmbed] - from {@link buildMapEmbedHtml}
 * @param {Map<string, string>} [opts.figures] - chart_id → static chart markup (ChartRenderer#exportFigure)
 * @param {(md: string) => string} [opts.renderMarkdown]
 * @returns {string} a complete HTML document
 */
export function buildReportHtml(record, opts = {}) {
    const renderMd = opts.renderMarkdown || renderMarkdown;
    const turns = (record?.turns || []).filter(t => t.prompt != null);
    const exportedAt = opts.exportedAt || new Date();
    const appTitle = opts.appTitle || 'GLEN';
    const appUrl = opts.appUrl || '';
    const codeLang = opts.codeLanguage || 'sql';
    const projectUrl = opts.projectUrl || GLEN_PROJECT_URL;
    const mapEmbed = opts.mapEmbed || { headTags: '', body: '' };
    const models = sessionModels({ turns });
    const multiModel = models.length > 1;

    const dates = [...new Set(turns.map(t => formatDate(t.startedAt)).filter(Boolean))];
    const sessionDate = dates.length ? dates.join(' – ') : formatDate(exportedAt.toISOString());
    const modelsText = models.length ? models.map(modelName).join(', ') : modelName(null);
    const version = opts.version
        ? `GLEN <code>${escapeHtmlText(opts.version)}</code>` : 'a development build of GLEN';
    const attr = (s) => escapeHtmlText(s);

    const setupChunks = CODE_LANGUAGES.map(l =>
        `<pre class="code-variant" data-lang="${l.id}"><code class="language-${l.id}">` +
        `${escapeHtmlText(buildSetupSnippet(l.id, opts.s3Endpoint))}</code></pre>`
    ).join('');

    const langButtons = CODE_LANGUAGES.map(l =>
        `<button type="button" data-set-lang="${l.id}" aria-pressed="${l.id === codeLang}">${escapeHtmlText(l.label)}</button>`
    ).join('');

    const toc = turns.length > 1
        ? `<nav class="report-toc" aria-label="Contents"><p class="report-toc-title">Contents</p><ol>` +
          turns.map((t, i) => `<li><a href="#q-${i + 1}">${escapeHtmlText(tocLabel(t.prompt))}</a></li>`).join('') +
          (turns.some(t => (t.steps || []).length) ? `<li class="report-toc-log"><a href="#session-log">Session log</a></li>` : '') +
          `</ol></nav>`
        : '';

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="GLEN${opts.version ? ' ' + attr(opts.version) : ''}">
<title>${escapeHtmlText(opts.title || appTitle)}</title>
<style>${REPORT_CSS}</style>
${mapEmbed.headTags}
</head>
<body data-code-lang="${attr(codeLang)}" data-print="full">
<header class="report-header">
  <h1 class="report-title">${escapeHtmlText(appTitle)}</h1>
  <p class="report-subtitle">Analysis session · ${escapeHtmlText(sessionDate)}</p>
  <aside class="report-disclosure">
    Outputs generated with <a href="${attr(projectUrl)}">GLEN</a> using ${modelsText} on ${escapeHtmlText(sessionDate)}.
    The code below is exactly what the agent ran; the text around it was written by the model —
    check it against the code and its output.
  </aside>
  <div class="report-controls">
    <div class="code-fold-toggle" role="group" aria-label="Code">
      <button type="button" data-code-all="show">Show all code</button><button type="button" data-code-all="hide">Hide all code</button>
    </div>
    <div class="code-lang-toggle" role="group" aria-label="Show code as">
      <span class="code-lang-label">Code as</span>${langButtons}
    </div>
    <div class="export-print-controls">
      <label class="export-print-report"><input type="checkbox" id="export-report-style"> Print without code</label>
      <button type="button" class="export-print-btn">Print / Save as PDF</button>
    </div>
  </div>
</header>
${toc}
<section class="report-setup" id="setup">
  <details class="chunk-code"><summary>Code <span class="chunk-tool">setup</span></summary><div class="code-variants">${setupChunks}</div></details>
  <p class="report-setup-note">To re-run this analysis yourself, run the setup chunk once: it points <code>s3://</code> paths at the
     public endpoint (<code>${escapeHtmlText(opts.s3Endpoint || PUBLIC_S3_ENDPOINT)}</code>) with anonymous access.
     Public buckets only — private data is not reachable this way.</p>
</section>
${mapEmbed.body}
<main class="report-body">
${turns.map((t, i) => sectionHtml(t, i, renderMd, multiModel, opts.figures)).join('\n')}
</main>
${sessionLogHtml({ turns })}
<footer class="report-colophon">
  <p>Generated with ${version}${appUrl ? ` in <a href="${attr(appUrl)}">${escapeHtmlText(appTitle)}</a>` : ''}.
     Exported ${escapeHtmlText(exportedAt.toLocaleString())}.</p>
</footer>
${EXPORT_CODE_LANG_SCRIPT}
${EXPORT_CODE_FOLD_SCRIPT}
${EXPORT_PRINT_SCRIPT}
</body>
</html>`;
}

/**
 * Inline script: "Show all code / Hide all code", as R Markdown's
 * `code_folding` gives. Chunks are `<details>`, so each also folds alone.
 */
const EXPORT_CODE_FOLD_SCRIPT = `<script>
(function () {
  var strip = document.querySelector('.code-fold-toggle');
  if (!strip) return;
  strip.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('button[data-code-all]') : null;
    if (!b) return;
    var open = b.getAttribute('data-code-all') === 'show';
    var chunks = document.querySelectorAll('details.chunk-code');
    for (var i = 0; i < chunks.length; i++) chunks[i].open = open;
  });
})();
<\/script>`;

/** Report stylesheet: a Quarto-ish document, light, print-ready. */
const REPORT_CSS = `
:root { --fg: #212529; --muted: #6c757d; --rule: #dee2e6; --code-bg: #f6f8fa;
        --accent: #2c5282; --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        --mono: SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }
* { box-sizing: border-box; }
html { background: #fff; }
body { font-family: var(--font); color: var(--fg); background: #fff; line-height: 1.6; font-size: 16px;
       max-width: 860px; margin: 0 auto; padding: 2rem 16px 4rem; }
a { color: var(--accent); }
code { font-family: var(--mono); font-size: 0.875em; }
p code, li code, td code { background: rgba(0,0,0,0.04); padding: 0.1em 0.3em; border-radius: 3px; }

.report-header { margin-bottom: 1.5rem; }
.report-title { font-size: 2.1rem; line-height: 1.2; margin: 0 0 0.25rem; font-weight: 600; }
.report-subtitle { color: var(--muted); margin: 0 0 1rem; font-size: 1.05rem; }
.report-disclosure { border-left: 4px solid #0d6efd; background: #f3f7ff; padding: 0.6rem 0.9rem;
                     border-radius: 0 4px 4px 0; font-size: 0.92rem; margin: 0 0 1rem; }
.report-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; font-size: 13px; }
.report-controls button { font: inherit; font-size: 12px; padding: 3px 10px; cursor: pointer;
                          border: 1px solid #ced4da; background: #fff; color: #495057; }
.code-fold-toggle, .code-lang-toggle { display: flex; align-items: center; }
.code-fold-toggle button:first-child, .code-lang-toggle button:nth-child(2) { border-radius: 4px 0 0 4px; }
.code-fold-toggle button:last-child, .code-lang-toggle button:last-child { border-radius: 0 4px 4px 0; }
.code-fold-toggle button + button, .code-lang-toggle button + button { border-left: 0; }
.code-lang-label { color: var(--muted); margin-right: 6px; }
.code-lang-toggle button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #fff; }
.export-print-controls { display: flex; align-items: center; gap: 8px; color: var(--muted); margin-left: auto; }
.export-print-report { display: flex; align-items: center; gap: 4px; cursor: pointer; }
.export-print-btn { border-radius: 4px; }

.report-toc { font-size: 0.9rem; border: 1px solid var(--rule); border-radius: 6px; padding: 0.6rem 1rem; margin: 0 0 1.5rem; }
.report-toc-title { font-weight: 600; margin: 0 0 0.25rem; }
.report-toc ol { margin: 0; padding-left: 1.4rem; }
.report-toc li { margin: 0.15rem 0; }
.report-toc a { text-decoration: none; }
.report-toc a:hover { text-decoration: underline; }
.report-toc-log { list-style: none; margin-left: -1.4rem !important; margin-top: 0.4rem !important; }
@media (min-width: 1360px) {
  .report-toc { position: fixed; top: 2rem; left: calc(50% - 430px - 270px); width: 240px;
                border: 0; border-left: 1px solid var(--rule); border-radius: 0; padding: 0 0 0 1rem;
                max-height: calc(100vh - 4rem); overflow-y: auto; }
}

/* Code chunks: folded by default, like R Markdown's code_folding: hide. */
.chunk { margin: 1rem 0; }
details.chunk-code > summary { cursor: pointer; list-style: none; color: var(--muted); font-size: 0.85rem;
                               display: inline-flex; align-items: center; gap: 6px; padding: 2px 0; user-select: none; }
details.chunk-code > summary::-webkit-details-marker { display: none; }
details.chunk-code > summary::before { content: '▸'; font-size: 0.8em; }
details.chunk-code[open] > summary::before { content: '▾'; }
.chunk-tool { font-family: var(--mono); font-size: 0.8rem; color: #868e96; }
.code-variant { display: none; margin: 0.35rem 0 0; background: var(--code-bg); border-left: 3px solid var(--rule);
                padding: 0.75rem 1rem; overflow-x: auto; font-size: 0.82rem; line-height: 1.45; }
body[data-code-lang="sql"] .code-variant[data-lang="sql"],
body[data-code-lang="r"] .code-variant[data-lang="r"],
body[data-code-lang="python"] .code-variant[data-lang="python"] { display: block; }
.chunk-output { margin: 0.5rem 0 0; overflow-x: auto; }
pre.chunk-output { padding: 0.5rem 1rem; border: 1px solid var(--rule); border-radius: 4px; font-size: 0.82rem;
                   white-space: pre-wrap; word-break: break-word; max-height: 24rem; overflow-y: auto; }
.chunk-output table, .report-prose table { border-collapse: collapse; font-size: 0.85rem; margin: 0.5rem 0; }
.chunk-output th, .chunk-output td, .report-prose th, .report-prose td { border-bottom: 1px solid var(--rule); padding: 0.3rem 0.75rem; text-align: left; }
.chunk-output th, .report-prose th { border-bottom: 2px solid #adb5bd; font-weight: 600; }
.chunk-output td { font-family: var(--mono); font-size: 0.8rem; }
.chunk-figure { margin: 0.75rem 0 0; }
.chunk-figure svg, .chunk-figure > figure { max-width: 100%; height: auto; }
.chunk-figure figcaption { color: var(--muted); font-size: 0.85rem; margin-top: 0.25rem; }
.chunk-more, .chunk-effect { color: var(--muted); font-size: 0.85rem; margin: 0.35rem 0 0; }

/* Sections */
.report-section { margin: 2.5rem 0 0; }
.report-section h2 { font-size: 1.4rem; font-weight: 600; line-height: 1.3; margin: 0 0 0.25rem;
                     padding-bottom: 0.3rem; border-bottom: 1px solid var(--rule); }
.q-num { color: var(--muted); font-weight: 400; }
.report-meta, .report-consulted, .report-map-step { color: var(--muted); font-size: 0.85rem; margin: 0.35rem 0; }
.report-map-step::before { content: '◆ '; color: #adb5bd; }
.report-prose { margin-top: 1.25rem; }
.report-prose h1, .report-prose h2, .report-prose h3 { font-size: 1.1rem; margin: 1.25rem 0 0.5rem; border: 0; }
.report-note { color: var(--muted); font-style: italic; font-size: 0.9rem; }
.report-note.error { color: #b02a37; }
.report-setup { margin: 0 0 1.5rem; }
.report-setup-note { color: var(--muted); font-size: 0.85rem; margin: 0.35rem 0 0; }

/* The map, as the report's figure. */
.export-map-section { margin: 0 0 1.5rem; }
.export-map-title { font-size: 1rem; font-weight: 600; margin: 0 0 0.5rem; }
.export-map { width: 100%; height: 480px; border: 1px solid var(--rule); border-radius: 4px; }
.export-map-note { font-size: 0.82rem; color: var(--muted); margin: 6px 0 0; }
.export-map-error { padding: 1rem; color: #991b1b; font-size: 13px; }
.export-embed { margin: 8px 0 0; }
.export-embed-toggle { font: inherit; font-size: 12px; padding: 4px 10px; cursor: pointer;
                       border: 1px solid #ced4da; border-radius: 4px; background: #fff; color: var(--accent); }
.export-embed-toggle[aria-expanded="true"] { background: #eef2ff; border-color: #c7d2fe; }
.export-embed-help { border: 1px solid var(--rule); border-radius: 6px; padding: 10px 12px;
                     margin: 8px 0 0; font-size: 13px; background: #f8f9fa; }
.export-embed-help ol { margin: 8px 0; padding-left: 20px; }
.export-embed-help li { margin: 6px 0; }
.export-embed-snippet { background: var(--code-bg); padding: 8px; border-radius: 4px; overflow-x: auto;
                        font-size: 11px; white-space: pre-wrap; word-break: break-word; margin: 6px 0; }
.export-embed-copy { font: inherit; font-size: 11px; padding: 2px 8px; cursor: pointer;
                     border: 1px solid #ced4da; border-radius: 4px; background: #fff; color: #495057; }
.export-embed-note { font-size: 12px; color: var(--muted); margin: 8px 0 0; }

/* Appendix */
.report-appendix { margin: 3.5rem 0 0; padding-top: 1rem; border-top: 2px solid var(--rule); }
.report-appendix h2 { font-size: 1.2rem; margin: 0 0 0.25rem; }
.report-appendix-note { color: var(--muted); font-size: 0.85rem; }
.log-turn { border: 1px solid var(--rule); border-radius: 4px; margin: 0.5rem 0; padding: 0.4rem 0.75rem; }
.log-turn > summary { cursor: pointer; font-size: 0.9rem; }
.log-call { margin: 0.75rem 0; font-size: 0.8rem; }
.log-call.failed .log-call-name { color: #b02a37; }
.log-call-name { margin: 0 0 0.25rem; }
.log-tag { font-size: 10px; padding: 1px 5px; border-radius: 3px; background: #dbeafe; color: #1e40af; }
.log-args, .log-result { background: var(--code-bg); padding: 0.4rem 0.6rem; margin: 0.25rem 0; overflow-x: auto;
                         white-space: pre-wrap; word-break: break-word; max-height: 18rem; overflow-y: auto; font-size: 0.75rem; }
.log-note { color: var(--muted); font-size: 0.8rem; font-style: italic; margin: 0.25rem 0; }
.report-colophon { margin-top: 3rem; padding-top: 0.75rem; border-top: 1px solid var(--rule); color: var(--muted); font-size: 0.8rem; }

/* '#map' view: the same file, stripped to the map, which is what the embed
   snippet points an iframe at. */
body[data-view="map"] { margin: 0; padding: 0; max-width: none; }
body[data-view="map"] > *:not(.export-map-section) { display: none !important; }
body[data-view="map"] .export-map-title,
body[data-view="map"] .export-map-note,
body[data-view="map"] .export-embed { display: none; }
body[data-view="map"] .export-map-section { margin: 0; }
body[data-view="map"] .export-map { height: 100vh; border: 0; border-radius: 0; }

@media (max-width: 600px) {
  body { padding-top: 1rem; font-size: 15px; }
  .report-title { font-size: 1.6rem; }
  .export-print-controls { margin-left: 0; }
}

/* Print: the report goes to a board or a funder, so it prints as a document. */
@media print {
  body { max-width: none; margin: 0; padding: 0; }
  .report-controls, .export-embed, .report-toc { display: none !important; }
  a { color: inherit; text-decoration: none; }
  .chunk, .chunk-figure, .code-variants, pre, .export-map-section, .report-prose table, .log-call { break-inside: avoid; }
  .report-section h2 { break-after: avoid; }
  pre.chunk-output, .log-args, .log-result { max-height: none; overflow: visible; }
  .export-map { height: 420px; }
  details.chunk-code > summary::before { content: ''; }
  /* Print without code: the questions, answers, outputs and map. */
  body[data-print="report"] details.chunk-code,
  body[data-print="report"] .report-setup,
  body[data-print="report"] .report-appendix { display: none !important; }
}
`;
