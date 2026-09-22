// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChatUI, resolveExportConfig } from '../app/chat-ui.js';

/**
 * #368 §3 — the exported document itself, not just the string helpers.
 * `exportHtml` ends in a download, so we capture the Blob it builds.
 */
function exportWith({ config = {}, messagesHtml = '', mapState = null } = {}) {
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
        ui.messagesEl.innerHTML = messagesHtml;
        ui.mapManager = mapState ? { getExportState: () => mapState } : null;
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

const SQL = "SELECT count(*) FROM read_parquet('s3://public-iucn/hex/mammals_sr/h0=*/data_0.parquet')";
const oneQuery =
    `<div class="agent-turn-row-body"><details class="sql-detail"><summary>SQL</summary>` +
    `<pre><code class="language-sql">${SQL}</code></pre></details></div>`;

describe('exported document: code languages (#368)', () => {
    it('renders every query once per language', () => {
        const doc = openExport(exportWith({ messagesHtml: oneQuery }));
        const variants = doc.querySelectorAll('main .code-variant');
        expect([...variants].map(v => v.dataset.lang)).toEqual(['sql', 'r', 'python']);
        expect(variants[0].textContent).toBe(SQL);
        expect(variants[1].textContent).toContain('dbGetQuery(con, r"(');
        expect(variants[2].textContent).toContain('con.sql(r"""');
        // The query text itself is identical in all three.
        for (const v of variants) expect(v.textContent).toContain(SQL);
    });

    it('carries a setup block per language', () => {
        const doc = openExport(exportWith({ messagesHtml: oneQuery }));
        const setup = doc.querySelectorAll('.export-setup .code-variant');
        expect([...setup].map(v => v.dataset.lang)).toEqual(['sql', 'r', 'python']);
        expect(setup[1].textContent).toContain('library(duckdb)');
        expect(setup[2].textContent).toContain('import duckdb');
    });

    it('opens on SQL by default and on the configured language otherwise', () => {
        expect(openExport(exportWith({ messagesHtml: oneQuery })).body.dataset.codeLang).toBe('sql');
        const doc = openExport(exportWith({
            config: { export: { default_code_language: 'r' } }, messagesHtml: oneQuery,
        }));
        expect(doc.body.dataset.codeLang).toBe('r');
        expect(doc.querySelector('[data-set-lang="r"]').getAttribute('aria-pressed')).toBe('true');
    });

    it('relabels the collapsed row, which no longer only holds SQL', () => {
        const doc = openExport(exportWith({ messagesHtml: oneQuery }));
        expect(doc.querySelector('details.sql-detail > summary').textContent).toBe('Query');
    });

    it('switches every block at once when a language button is clicked', () => {
        const doc = openExport(exportWith({ messagesHtml: oneQuery }));
        doc.querySelector('[data-set-lang="python"]').click();
        expect(doc.body.dataset.codeLang).toBe('python');
        expect(doc.querySelector('[data-set-lang="python"]').getAttribute('aria-pressed')).toBe('true');
        expect(doc.querySelector('[data-set-lang="sql"]').getAttribute('aria-pressed')).toBe('false');
    });

    it('remembers the choice for the next export the reader opens', () => {
        localStorage.clear();
        const first = openExport(exportWith({ messagesHtml: oneQuery }));
        first.querySelector('[data-set-lang="r"]').click();
        expect(localStorage.getItem('glen-export-code-lang')).toBe('r');

        const second = openExport(exportWith({ messagesHtml: oneQuery }));
        expect(second.body.dataset.codeLang).toBe('r');
        localStorage.clear();
    });

    it('still scrubs credentials that reached the transcript', () => {
        const html = exportWith({
            messagesHtml: '<div class="chat-message assistant">Authorization: Bearer sk-abc123</div>',
        });
        expect(html).not.toContain('sk-abc123');
        expect(html).toContain('[REDACTED]');
    });

    it('drops transient UI but keeps the toggle, which lives outside the transcript', () => {
        const doc = openExport(exportWith({
            messagesHtml: oneQuery +
                '<div class="tool-approval-buttons"><button class="approve-yes">Run</button></div>',
        }));
        expect(doc.querySelector('main .tool-approval-buttons')).toBe(null);
        expect(doc.querySelectorAll('.code-lang-toggle button').length).toBe(3);
    });
});

describe('exported document: embed affordance (#368 §2)', () => {
    it('offers the embed panel, collapsed, when there is a map', () => {
        const doc = openExport(exportWith({ messagesHtml: oneQuery, mapState: MAP_STATE }));
        const toggle = doc.querySelector('.export-embed-toggle');
        expect(toggle).not.toBe(null);
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expect(doc.getElementById('export-embed-help').hasAttribute('hidden')).toBe(true);
    });

    it('offers nothing to embed when the export has no map', () => {
        const doc = openExport(exportWith({ messagesHtml: oneQuery }));
        expect(doc.querySelector('.export-embed')).toBe(null);
        expect(doc.querySelector('.export-map-section')).toBe(null);
    });

    it('names the file the reader actually downloaded in the snippet', () => {
        const html = exportWith({ messagesHtml: oneQuery, mapState: MAP_STATE });
        const doc = openExport(html);
        const snippet = doc.querySelector('.export-embed-snippet code').textContent;
        // Same stamped filename the download carries, or the instructions send
        // their web person looking for a file that does not exist.
        const filename = /glen-chat-[\d-]+\.html/.exec(html)[0];
        expect(snippet).toContain(`src="${filename}#map"`);
        expect(snippet).toContain('<iframe');
        expect(snippet).toContain('title="Map"');
    });

    it('expands the instructions on click', () => {
        const doc = openExport(exportWith({ messagesHtml: oneQuery, mapState: MAP_STATE }));
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
            const doc = openExport(exportWith({ messagesHtml: oneQuery, mapState: MAP_STATE }));
            expect(doc.body.dataset.view).toBe('map');
        } finally {
            window.location.hash = '';
        }
    });

    it('shows the whole transcript without the fragment', () => {
        const doc = openExport(exportWith({ messagesHtml: oneQuery, mapState: MAP_STATE }));
        expect(doc.body.dataset.view).toBe('full');
    });

    it('sets up the embed even when MapLibre fails to load', () => {
        // jsdom has no maplibregl, so this exercises the error path: the map
        // reports itself broken, and the page around it still works.
        const doc = openExport(exportWith({ messagesHtml: oneQuery, mapState: MAP_STATE }));
        expect(doc.querySelector('.export-map-error')).not.toBe(null);
        expect(doc.body.dataset.view).toBe('full');
        doc.querySelector('.export-embed-toggle').click();
        expect(doc.getElementById('export-embed-help').hasAttribute('hidden')).toBe(false);
    });

    it('keeps the canvas readable for printing and snapshots', () => {
        const html = exportWith({ messagesHtml: oneQuery, mapState: MAP_STATE });
        expect(html).toContain('preserveDrawingBuffer: true');
    });
});
