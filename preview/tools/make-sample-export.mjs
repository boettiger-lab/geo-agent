#!/usr/bin/env node
/**
 * Generate `preview/sample-export.html` — a real exported transcript, so the
 * export can be reviewed by opening it rather than by reading a diff.
 *
 * It drives the actual ChatUI methods (startTurn / showToolProposal /
 * showToolResults / addMarkdown / exportHtml) in jsdom, with marked and
 * DOMPurify wired up as the browser supplies them. Nothing about the export
 * path is stubbed, so what lands in the file is what a user's download
 * contains.
 *
 * The transcript is a fixture, but the *numbers in it are real*: every query
 * below was run against the public bucket and the results pasted back. A
 * sample carrying invented figures would be worse than no sample.
 *
 *   node preview/tools/make-sample-export.mjs
 *
 * It lives in `tools/` rather than beside the fixture because the Pages
 * staging step publishes `preview/*` at depth 1 — a generator served next to
 * the app would be noise.
 */

import { JSDOM } from 'jsdom';
import { marked } from 'marked';
import createDOMPurify from 'dompurify';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'sample-export.html');

/* ── A browser, near enough ─────────────────────────────────────────────── */

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,   // gives us requestAnimationFrame
    url: 'https://boettiger-lab.github.io/geo-agent/preview/',
});
const { window } = dom;

for (const key of ['window', 'document', 'Node', 'NodeFilter', 'HTMLElement',
                   'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage',
                   'Event']) {
    globalThis[key] = window[key];
}
globalThis.marked = marked;
globalThis.DOMPurify = createDOMPurify(window);

// exportHtml() ends in a download. Capture the Blob instead of navigating.
let captured = '';
globalThis.Blob = class { constructor(parts) { captured = parts.join(''); } };
globalThis.URL = { createObjectURL: () => 'blob:sample', revokeObjectURL: () => {} };
window.HTMLAnchorElement.prototype.click = () => {};

const { ChatUI, resolveExportConfig } = await import('../../app/chat-ui.js');
const { ChartRenderer } = await import('../../app/chart-renderer.js');

// Charts draw through the real ChartRenderer, with Observable Plot from
// devDependencies (pinned to the version the app loads from the CDN) in place
// of the browser's lazy CDN load.
globalThis.Plot = await import('@observablehq/plot');
const chartRenderer = new ChartRenderer({ doc: window.document });

/* ── The session ────────────────────────────────────────────────────────── */

// A real session, not an invented one: the TPL Protected Lands Explorer on
// 2026-10-01, rebuilt from that day's chat export (sample-session.json). The
// prompts, calls, SQL, results, answers and final map are verbatim. The old
// export never recorded the model — the gap #388 closes — so the model below
// is the TPL app's configured default, not one read off the session. A turn
// marked `synthetic` was appended to exercise a feature the real session
// didn't use (render_chart); its note says what in it is real.
const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'sample-session.json'), 'utf8'));
const SESSION_STARTED = ['2026-10-01T19:24:00Z', '2026-10-01T19:33:00Z', '2026-10-01T19:38:00Z'];

window.document.title = 'TPL — Protected Lands Explorer';

const ui = Object.create(ChatUI.prototype);
ui.config = {
    export: { public_s3_endpoint: 's3-west.nrp-nautilus.io' },
    llm_models: [{ value: 'z-ai/glm-5.2', label: 'GLM-5.2 (OpenRouter)' }],
};
ui.exportConfig = resolveExportConfig(ui.config);
ui.agent = { selectedModel: 'z-ai/glm-5.2' };
ui.messagesEl = window.document.createElement('div');
ui.messagesEl.id = 'chat-messages';
ui.mapManager = { getExportState: () => fixture.mapState };
// The catalog the Data sources section cites from: the real STAC records of
// the datasets the session read (sample-catalog.json, verbatim but trimmed).
const stac = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'sample-catalog.json'), 'utf8'));
ui.catalog = { getAll: () => stac.collections.map(c => ({ id: c.id, _rawStac: c })) };
ui.chartRenderer = chartRenderer;
window.document.body.appendChild(ui.messagesEl);

// Replay each turn through the methods the agent drives, one call per round.
for (const [t, turn] of fixture.turns.entries()) {
    ui.addMessage('user', turn.prompt);
    ui.startTurn();
    for (const [i, step] of turn.steps.entries()) {
        const iter = i + 1;
        const call = { id: `c${t}-${i}`, type: 'function',
                       function: { name: step.name, arguments: JSON.stringify(step.args) } };
        ui.showToolProposal([call], null, iter, true);
        if (step.name === 'render_chart') {
            // Draw it for real, so the result carries a live chart_id.
            const { id } = await chartRenderer.render(step.args, step.args.data);
            step.result = JSON.stringify({ success: true, chart_id: id, chart_type: step.args.chart_type,
                                           title: step.args.title || null, points: step.args.data.length });
        }
        ui.showToolResults([step], iter);
    }
    ui.endTurn(turn.status || 'done');
    if (turn.answer) ui.addMarkdown('assistant', turn.answer);
    ui.session.turns[t].startedAt = SESSION_STARTED[t] || SESSION_STARTED[SESSION_STARTED.length - 1];
}

/* ── Export ─────────────────────────────────────────────────────────────── */

ui.exportHtml();
if (!captured) throw new Error('export produced no output');
writeFileSync(OUT, captured);
console.log(`wrote ${OUT} (${(captured.length / 1024).toFixed(1)} KB)`);
