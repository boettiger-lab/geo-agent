// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChatUI, resolveExportConfig } from '../app/chat-ui.js';

/**
 * #368 / #388 — the exported document itself, not just the string helpers.
 * `exportHtml` ends in a download, so we capture the Blob it builds. The
 * session is replayed through the same ChatUI methods the agent drives, so
 * the recording hooks are exercised too.
 */
function exportWith({ config = {}, turns = [], mapState = null, model = 'test-model' } = {}) {
    let captured = '';
    const RealBlob = globalThis.Blob;
    globalThis.Blob = class { constructor(parts) { captured = parts.join(''); } };
    const objectUrl = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} };
    const realUrl = globalThis.URL;
    globalThis.URL = objectUrl;
    const realClick = window.HTMLAnchorElement.prototype.click;
    window.HTMLAnchorElement.prototype.click = () => {};

    try {
        const ui = Object.create(ChatUI.prototype);
        ui.config = config;
        ui.exportConfig = resolveExportConfig(config);
        ui.messagesEl = document.createElement('div');
        ui.agent = { selectedModel: model };
        ui.mapManager = mapState ? { getExportState: () => mapState } : null;
        replay(ui, turns);
        ui.exportHtml();
        return captured;
    } finally {
        globalThis.Blob = RealBlob;
        globalThis.URL = realUrl;
        window.HTMLAnchorElement.prototype.click = realClick;
    }
}

/** Parse an exported document and run its inline scripts, as a browser would. */
function openExport(html) {
    const doc = document.implementation.createHTMLDocument('export');
    doc.documentElement.innerHTML = html
        .replace(/^[\s\S]*?<html[^>]*>/i, '')
        .replace(/<\/html>[\s\S]*$/i, '');
    // The <body> attributes are lost by the innerHTML round-trip; re-apply.
    const bodyAttrs = /<body([^>]*)>/i.exec(html)?.[1] ?? '';
    for (const [, name, value] of bodyAttrs.matchAll(/(\w[\w-]*)="([^"]*)"/g)) {
        doc.body.setAttribute(name, value);
    }
    for (const script of doc.querySelectorAll('script:not([type])')) {
        // Run the toggle script against the parsed document.
        new Function('document', 'localStorage', script.textContent)(doc, localStorage);
    }
    return doc;
}

const MAP_STATE = {
    center: [-119.4, 36.8], zoom: 6, bearing: 0, pitch: 0, projection: 'mercator',
    style: { version: 8, sources: {}, layers: [] },
};

/** Drive a session through ChatUI as the agent would: one round per step. */
function replay(ui, turns) {
    for (const turn of turns) {
        ui.addMessage('user', turn.prompt);
        ui.startTurn();
        (turn.steps || []).forEach((step, i) => {
            const call = { id: `c${i}`, type: 'function',
                           function: { name: step.name, arguments: JSON.stringify(step.args || {}) } };
            ui.showToolProposal([call], null, i + 1, true);
            ui.showToolResults([{ success: true, source: 'remote', result: '', ...step }], i + 1);
        });
        ui.endTurn('done');
        if (turn.answer) ui.addMarkdown('assistant', turn.answer);
    }
}

const SQL = "SELECT count(*) FROM read_parquet('s3://public-iucn/hex/mammals_sr/h0=*/data_0.parquet')";
const oneQuery = [{
    prompt: 'How many cells?',
    steps: [{ name: 'query', args: { sql_query: SQL }, sqlQuery: SQL, result: '| n |\n|---|\n| 3 |' }],
    answer: 'Three.',
}];

describe('exported document: code languages (#368)', () => {
    it('renders every query once per language', () => {
        const doc = openExport(exportWith({ turns: oneQuery }));
        // Exactly one chunk: the query is not repeated by its result (#388).
        const variants = doc.querySelectorAll('main .chunk .code-variant');
        expect([...variants].map(v => v.dataset.lang)).toEqual(['sql', 'r', 'python']);
        expect(variants[0].textContent).toBe(SQL);
        expect(variants[1].textContent).toContain('dbGetQuery(con, r"(');
        expect(variants[2].textContent).toContain('con.sql(r"""');
        // The query text itself is identical in all three.
        for (const v of variants) expect(v.textContent).toContain(SQL);
    });

    it('carries a setup block per language', () => {
        const doc = openExport(exportWith({ turns: oneQuery }));
        const setup = doc.querySelectorAll('.report-setup .code-variant');
        expect([...setup].map(v => v.dataset.lang)).toEqual(['sql', 'r', 'python']);
        expect(setup[1].textContent).toContain('library(duckdb)');
        expect(setup[2].textContent).toContain('import duckdb');
    });

    it('opens on SQL by default and on the configured language otherwise', () => {
        expect(openExport(exportWith({ turns: oneQuery })).body.dataset.codeLang).toBe('sql');
        const doc = openExport(exportWith({
            config: { export: { default_code_language: 'r' } }, turns: oneQuery,
        }));
        expect(doc.body.dataset.codeLang).toBe('r');
        expect(doc.querySelector('[data-set-lang="r"]').getAttribute('aria-pressed')).toBe('true');
    });

    it('folds every chunk by default, and shows or hides them all at once', () => {
        const doc = openExport(exportWith({ turns: oneQuery }));
        const chunks = [...doc.querySelectorAll('details.chunk-code')];
        expect(chunks.length).toBe(2);   // setup + the query
        expect(chunks.every(d => !d.open)).toBe(true);
        doc.querySelector('[data-code-all="show"]').click();
        expect(chunks.every(d => d.open)).toBe(true);
        doc.querySelector('[data-code-all="hide"]').click();
        expect(chunks.every(d => !d.open)).toBe(true);
    });

    it('switches every block at once when a language button is clicked', () => {
        const doc = openExport(exportWith({ turns: oneQuery }));
        doc.querySelector('[data-set-lang="python"]').click();
        expect(doc.body.dataset.codeLang).toBe('python');
        expect(doc.querySelector('[data-set-lang="python"]').getAttribute('aria-pressed')).toBe('true');
        expect(doc.querySelector('[data-set-lang="sql"]').getAttribute('aria-pressed')).toBe('false');
    });

    it('remembers the choice for the next export the reader opens', () => {
        localStorage.clear();
        const first = openExport(exportWith({ turns: oneQuery }));
        first.querySelector('[data-set-lang="r"]').click();
        expect(localStorage.getItem('glen-export-code-lang')).toBe('r');

        const second = openExport(exportWith({ turns: oneQuery }));
        expect(second.body.dataset.codeLang).toBe('r');
        localStorage.clear();
    });

    it('still scrubs credentials that reached the transcript', () => {
        const html = exportWith({
            turns: [{ prompt: 'q', answer: 'Authorization: Bearer sk-abc123' }],
        });
        expect(html).not.toContain('sk-abc123');
        expect(html).toContain('[REDACTED]');
    });

    it('carries no live-chat UI: it is built from the record, not the panel', () => {
        const doc = openExport(exportWith({ turns: oneQuery }));
        expect(doc.querySelector('.tool-approval-buttons, .agent-turn, .chat-message')).toBe(null);
        expect(doc.querySelectorAll('.code-lang-toggle button').length).toBe(3);
    });
});

describe('exported document: embed affordance (#368 §2)', () => {
    it('offers the embed panel, collapsed, when there is a map', () => {
        const doc = openExport(exportWith({ turns: oneQuery, mapState: MAP_STATE }));
        const toggle = doc.querySelector('.export-embed-toggle');
        expect(toggle).not.toBe(null);
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expect(doc.getElementById('export-embed-help').hasAttribute('hidden')).toBe(true);
    });

    it('offers nothing to embed when the export has no map', () => {
        const doc = openExport(exportWith({ turns: oneQuery }));
        expect(doc.querySelector('.export-embed')).toBe(null);
        expect(doc.querySelector('.export-map-section')).toBe(null);
    });

    it('names the file the reader actually downloaded in the snippet', () => {
        const html = exportWith({ turns: oneQuery, mapState: MAP_STATE });
        const doc = openExport(html);
        const snippet = doc.querySelector('.export-embed-snippet code').textContent;
        // Same stamped filename the download carries, or the instructions send
        // their web person looking for a file that does not exist.
        const filename = /glen-session-[\d-]+\.html/.exec(html)[0];
        expect(snippet).toContain(`src="${filename}#map"`);
        expect(snippet).toContain('<iframe');
        expect(snippet).toContain('title="Map"');
    });

    it('expands the instructions on click', () => {
        const doc = openExport(exportWith({ turns: oneQuery, mapState: MAP_STATE }));
        const toggle = doc.querySelector('.export-embed-toggle');
        toggle.click();
        expect(doc.getElementById('export-embed-help').hasAttribute('hidden')).toBe(false);
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        toggle.click();
        expect(doc.getElementById('export-embed-help').hasAttribute('hidden')).toBe(true);
    });

    it('strips the page to the map alone at #map', () => {
        window.location.hash = '#map';
        try {
            const doc = openExport(exportWith({ turns: oneQuery, mapState: MAP_STATE }));
            expect(doc.body.dataset.view).toBe('map');
        } finally {
            window.location.hash = '';
        }
    });

    it('shows the whole transcript without the fragment', () => {
        const doc = openExport(exportWith({ turns: oneQuery, mapState: MAP_STATE }));
        expect(doc.body.dataset.view).toBe('full');
    });

    it('sets up the embed even when MapLibre fails to load', () => {
        // jsdom has no maplibregl, so this exercises the error path: the map
        // reports itself broken, and the page around it still works.
        const doc = openExport(exportWith({ turns: oneQuery, mapState: MAP_STATE }));
        expect(doc.querySelector('.export-map-error')).not.toBe(null);
        expect(doc.body.dataset.view).toBe('full');
        doc.querySelector('.export-embed-toggle').click();
        expect(doc.getElementById('export-embed-help').hasAttribute('hidden')).toBe(false);
    });

    it('keeps the canvas readable for printing and snapshots', () => {
        const html = exportWith({ turns: oneQuery, mapState: MAP_STATE });
        expect(html).toContain('preserveDrawingBuffer: true');
    });
});

describe('exported document: printing (#368 §1)', () => {
    it('opens collapsed details for the print run, and closes them after', () => {
        const doc = openExport(exportWith({ turns: oneQuery }));
        const details = doc.querySelector('main details.chunk-code');
        expect(details.open).toBe(false);

        // Bound to the events, not to our button, so Ctrl+P behaves the same.
        window.dispatchEvent(new window.Event('beforeprint'));
        expect(details.open).toBe(true);
        window.dispatchEvent(new window.Event('afterprint'));
        expect(details.open).toBe(false);
    });

    it('leaves details the reader opened alone', () => {
        const doc = openExport(exportWith({ turns: oneQuery }));
        const details = doc.querySelector('main details.chunk-code');
        details.open = true;
        window.dispatchEvent(new window.Event('beforeprint'));
        window.dispatchEvent(new window.Event('afterprint'));
        expect(details.open).toBe(true);
    });

    it('keeps the session log folded on paper', () => {
        const doc = openExport(exportWith({ turns: oneQuery }));
        const log = doc.querySelector('details.log-turn');
        window.dispatchEvent(new window.Event('beforeprint'));
        expect(log.open).toBe(false);
        window.dispatchEvent(new window.Event('afterprint'));
    });

    it('switches to report style from the checkbox', () => {
        const doc = openExport(exportWith({ turns: oneQuery }));
        expect(doc.body.dataset.print).toBe('full');
        const check = doc.getElementById('export-report-style');
        check.checked = true;
        check.dispatchEvent(new window.Event('change'));
        expect(doc.body.dataset.print).toBe('report');
        check.checked = false;
        check.dispatchEvent(new window.Event('change'));
        expect(doc.body.dataset.print).toBe('full');
    });

    it('carries print rules for the traps that make a printed export useless', () => {
        const html = exportWith({ turns: oneQuery, mapState: MAP_STATE });
        const css = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
        const print = /@media print \{([\s\S]*)\}/.exec(css)[1];
        expect(print).toContain('break-inside: avoid');       // queries split across pages
        expect(print).toContain('max-height: none');          // scroll boxes clipped to a screenful
        expect(print).toContain('.report-controls');          // controls on paper
        expect(print).toContain('data-print="report"');       // the report variant
    });
});
