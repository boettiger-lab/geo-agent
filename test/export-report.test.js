// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
    buildReportHtml, classifyStep, stepSql, isFailedStep, libraryVersion,
    sessionModels, chartIdOf, GLEN_PROJECT_URL,
} from '../app/export-report.js';
import { ChatUI, resolveExportConfig } from '../app/chat-ui.js';

/** #388 — the session report: what goes in the body, what is left to the log. */

const Q = "SELECT count(*) AS n FROM read_parquet('s3://public-x/hex/h0=*/data_0.parquet')";
const step = (over) => ({ success: true, source: 'remote', result: '', args: {}, ...over });
const query = (sql = Q, result = '| n |\n|---|\n| 3 |') =>
    step({ name: 'query', args: { sql_query: sql }, sqlQuery: sql, result });

function report(turns, opts = {}) {
    const html = buildReportHtml({ turns }, { exportedAt: new Date('2026-10-01T20:00:00Z'), ...opts });
    const doc = document.implementation.createHTMLDocument('r');
    doc.documentElement.innerHTML = html.replace(/^[\s\S]*?<html[^>]*>/i, '').replace(/<\/html>[\s\S]*$/i, '');
    return { html, doc };
}

const turn = (over) => ({
    prompt: 'q', model: { id: 'z-ai/glm-5.2', label: 'GLM-5.2' },
    startedAt: '2026-10-01T19:00:00Z', status: 'done', steps: [], answer: null, notes: [], ...over,
});

describe('classifyStep', () => {
    it('makes a chunk of anything that carried SQL', () => {
        expect(classifyStep(query())).toBe('chunk');
        expect(classifyStep(step({ name: 'register_hex_tiles', args: { sql_query: Q } }))).toBe('chunk');
        expect(classifyStep(step({ name: 'render_chart', source: 'local', args: { sql: Q } }))).toBe('chunk');
    });

    it('treats lookups as consulted, even when they run locally', () => {
        expect(classifyStep(step({ name: 'get_schema', source: 'local', args: { dataset_id: 'x' } }))).toBe('consult');
        expect(classifyStep(step({ name: 'get_hex_tile_status', args: { hash: 'h' } }))).toBe('consult');
    });

    it('treats other local tools as map actions', () => {
        expect(classifyStep(step({ name: 'set_legend', source: 'local' }))).toBe('map');
    });

    it("does not mistake geocode's place-name `query` for SQL", () => {
        const s = step({ name: 'geocode', source: 'local', args: { query: 'Yosemite' } });
        expect(stepSql(s)).toBe(null);
        expect(classifyStep(s)).toBe('map');
    });

    it('sets failures aside, including a success:false envelope the registry let through', () => {
        expect(classifyStep(query(Q, 'Error: Binder Error'))).toBe('failed');
        expect(isFailedStep(step({ name: 'set_legend', source: 'local', result: '{"success": false}' }))).toBe(true);
        expect(classifyStep(step({ name: 'query', source: 'error', result: 'x' }))).toBe('failed');
    });
});

describe('libraryVersion', () => {
    it('reads the pin off a jsDelivr URL', () => {
        expect(libraryVersion('https://cdn.jsdelivr.net/gh/boettiger-lab/geo-agent@v3.28.0/app/export-report.js')).toBe('v3.28.0');
        expect(libraryVersion('https://cdn.jsdelivr.net/gh/boettiger-lab/geo-agent@0284371e/app/x.js')).toBe('0284371e');
    });
    it('is null for a local or preview build', () => {
        expect(libraryVersion('http://localhost:8000/app/export-report.js')).toBe(null);
    });
});

describe('buildReportHtml', () => {
    it('gives each question a section and a contents entry', () => {
        const { doc } = report([turn({ prompt: 'first?' }), turn({ prompt: 'second?' })]);
        expect([...doc.querySelectorAll('.report-section h2')].map(h => h.textContent))
            .toEqual(['1. first?', '2. second?']);
        expect(doc.querySelectorAll('.report-toc li a[href^="#q-"]').length).toBe(2);
    });

    it('shows each query once, as a chunk with its output table', () => {
        const { doc } = report([turn({ steps: [query()] })]);
        expect(doc.querySelectorAll('main .chunk').length).toBe(1);
        expect(doc.querySelectorAll('main .code-variant[data-lang="sql"]').length).toBe(1);
        expect(doc.querySelector('main .code-variant[data-lang="sql"]').textContent).toBe(Q);
    });

    it('caps a long output table and says so', () => {
        const rows = Array.from({ length: 30 }, (_, i) => `| ${i} |`).join('\n');
        const { html } = report([turn({ steps: [query(Q, `| n |\n|---|\n${rows}`)] })]);
        expect(html).toContain('Showing the first 20 of 30 rows.');
    });

    it('names consulted schemas in one line instead of dumping them', () => {
        const { doc } = report([turn({ steps: [
            step({ name: 'get_schema', source: 'local', args: { dataset_id: 'mobi' }, result: 'LONG SCHEMA TEXT' }),
            step({ name: 'get_schema', source: 'local', args: { dataset_id: 'carbon' }, result: 'LONG SCHEMA TEXT' }),
            query(),
        ] })]);
        const line = doc.querySelector('.report-consulted').textContent;
        expect(line).toContain('mobi');
        expect(line).toContain('carbon');
        expect(doc.querySelector('main').textContent).not.toContain('LONG SCHEMA TEXT');
        // …but the appendix keeps them whole.
        expect(doc.querySelector('#session-log').textContent).toContain('LONG SCHEMA TEXT');
    });

    it('notes map actions in a line, in order with the chunks', () => {
        const { doc } = report([turn({ steps: [
            query(),
            step({ name: 'add_hex_tile_layer', source: 'local', args: { display_name: 'Top 30%' } }),
        ] })]);
        const kids = [...doc.querySelector('.report-section').children].map(e => e.className);
        expect(kids.indexOf('chunk')).toBeLessThan(kids.indexOf('report-map-step'));
        expect(doc.querySelector('.report-map-step').textContent).toContain('Top 30%');
    });

    it('omits failed attempts from the body, says how many, and keeps them in the log', () => {
        const bad = "SELECT nope FROM read_parquet('s3://x')";
        const { doc } = report([turn({ steps: [query(bad, 'Error: Binder Error: nope'), query()] })]);
        expect(doc.querySelectorAll('main .chunk').length).toBe(1);
        expect(doc.querySelector('.report-meta').textContent).toContain('1 failed or retried');
        expect(doc.querySelector('main').textContent).not.toContain('nope');
        expect(doc.querySelector('#session-log-1 .log-call.failed').textContent).toContain('Binder Error');
    });

    it('puts the chronology first: chunks, then the answer', () => {
        const { doc } = report([turn({ steps: [query()], answer: 'The answer.' })]);
        const kids = [...doc.querySelector('.report-section').children].map(e => e.className);
        expect(kids.indexOf('chunk')).toBeLessThan(kids.indexOf('report-prose'));
    });

    it('discloses GLEN, the model and the date', () => {
        const { doc } = report([turn({})]);
        const d = doc.querySelector('.report-disclosure');
        expect(d.querySelector('a').getAttribute('href')).toBe(GLEN_PROJECT_URL);
        expect(d.textContent).toContain('GLM-5.2');
        expect(d.textContent).toContain('z-ai/glm-5.2');
        expect(d.textContent).toContain('October 1, 2026');
        expect(d.textContent).toContain('written by the model');
    });

    it('links the disclosure wherever the app points it', () => {
        const { doc } = report([turn({})], { projectUrl: 'https://glen.example.org/' });
        expect(doc.querySelector('.report-disclosure a').getAttribute('href')).toBe('https://glen.example.org/');
    });

    it('names every model a session used, and each section its own', () => {
        const { doc } = report([
            turn({ prompt: 'a' }),
            turn({ prompt: 'b', model: { id: 'qwen3', label: 'NRP Qwen3' } }),
        ]);
        const d = doc.querySelector('.report-disclosure').textContent;
        expect(d).toContain('GLM-5.2');
        expect(d).toContain('NRP Qwen3');
        const metas = [...doc.querySelectorAll('.report-section')].map(s => s.querySelector('.report-meta')?.textContent || '');
        expect(metas[0]).toContain('glm-5.2');
        expect(metas[1]).toContain('qwen3');
    });

    it('does not claim a model it never recorded', () => {
        const { doc } = report([turn({ model: null })]);
        expect(doc.querySelector('.report-disclosure').textContent).toContain('an unrecorded model');
    });

    it('carries the GLEN version when known', () => {
        expect(report([turn({})], { version: 'v3.29.0' }).html).toContain('GLEN <code>v3.29.0</code>');
        expect(report([turn({})]).html).toContain('a development build of GLEN');
    });

    it('says when a question was cancelled', () => {
        const { doc } = report([turn({ status: 'cancelled' })]);
        expect(doc.querySelector('.report-section').textContent).toContain('cancelled');
    });

    it('scrubs credentials from prompts, SQL, results and the log', () => {
        const leak = "CREATE SECRET s (KEY_ID 'AKIA123', SECRET 'shh')";
        const { html } = report([turn({ prompt: `use ${leak}`, steps: [query(leak, leak)] })]);
        expect(html).not.toContain('AKIA123');
        expect(html).not.toContain("'shh'");
    });
});

describe('render_chart in the report', () => {
    const SVG = '<svg class="plot"><text>Brazil</text></svg>';
    const chart = (over = {}) => step({
        name: 'render_chart', source: 'local',
        args: { chart_type: 'bar', title: 'Protected share', x: 'country', y: 'pct',
                data: [{ country: 'Brazil', pct: 31 }, { country: 'Peru', pct: 22 }] },
        result: JSON.stringify({ success: true, chart_id: 'chart-1', points: 2 }),
        ...over,
    });

    it('reads the chart_id off a successful result only', () => {
        expect(chartIdOf(chart())).toBe('chart-1');
        expect(chartIdOf(chart({ result: '{"success": false, "error": "no rows"}' }))).toBe(null);
        expect(chartIdOf(query())).toBe(null);
    });

    it('is a chunk even with inline data, so the figure sits in the run order', () => {
        expect(classifyStep(chart())).toBe('chunk');
    });

    it('shows the figure, captioned, beneath its chunk', () => {
        const { doc } = report([turn({ steps: [chart()] })], { figures: new Map([['chart-1', SVG]]) });
        const fig = doc.querySelector('main .chunk figure.chunk-figure');
        expect(fig.querySelector('svg.plot')).not.toBe(null);
        expect(fig.querySelector('figcaption').textContent).toContain('Protected share');
    });

    it('says when the rows came inline, since there is no query to re-run', () => {
        const { doc } = report([turn({ steps: [chart()] })], { figures: new Map([['chart-1', SVG]]) });
        expect(doc.querySelector('main .chunk details.chunk-code')).toBe(null);
        expect(doc.querySelector('figcaption').textContent).toContain('2 rows the model passed inline');
    });

    it('gives a SQL chart its code chunk too', () => {
        const s = chart({ args: { chart_type: 'bar', x: 'c', y: 'n', sql: Q } });
        const { doc } = report([turn({ steps: [s] })], { figures: new Map([['chart-1', SVG]]) });
        expect(doc.querySelector('main .chunk .code-variant[data-lang="sql"]').textContent).toBe(Q);
        expect(doc.querySelector('figcaption').textContent).not.toContain('inline');
    });

    it('falls back to a note when the figure could not be drawn', () => {
        const { doc } = report([turn({ steps: [chart()] })]);
        expect(doc.querySelector('main figure')).toBe(null);
        expect(doc.querySelector('main .chunk-effect').textContent).toContain('could not be carried');
    });

    it('leaves a failed chart to the log', () => {
        const { doc } = report([turn({ steps: [chart({ result: '{"success": false, "error": "no rows"}' })] })]);
        expect(doc.querySelector('main .chunk')).toBe(null);
        expect(doc.querySelector('.report-meta').textContent).toContain('1 failed');
    });
});

describe('ChatUI export: charts', () => {
    it('asks the chart renderer for each chart the session drew', () => {
        let captured = '';
        const RealBlob = globalThis.Blob, realUrl = globalThis.URL;
        const realClick = window.HTMLAnchorElement.prototype.click;
        globalThis.Blob = class { constructor(parts) { captured = parts.join(''); } };
        globalThis.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} };
        window.HTMLAnchorElement.prototype.click = () => {};
        try {
            const ui = Object.create(ChatUI.prototype);
            ui.config = {};
            ui.exportConfig = resolveExportConfig({});
            ui.messagesEl = document.createElement('div');
            ui.agent = { selectedModel: 'm' };
            const asked = [];
            ui.chartRenderer = { exportFigure: (id) => { asked.push(id); return '<svg id="drawn"></svg>'; } };
            ui.addMessage('user', 'chart it');
            ui.startTurn();
            ui.showToolProposal([{ id: 'a', type: 'function', function: { name: 'render_chart', arguments: '{"chart_type":"bar","x":"a","y":"b","data":[]}' } }], null, 1, true);
            ui.showToolResults([{ name: 'render_chart', success: true, source: 'local', result: '{"success":true,"chart_id":"chart-7"}' }], 1);
            ui.endTurn('done');
            ui.exportHtml();
            expect(asked).toEqual(['chart-7']);
            expect(captured).toContain('<svg id="drawn"></svg>');
        } finally {
            globalThis.Blob = RealBlob;
            globalThis.URL = realUrl;
            window.HTMLAnchorElement.prototype.click = realClick;
        }
    });
});

describe('sessionModels', () => {
    it('lists distinct models in order of first use', () => {
        const a = { id: 'a' }, b = { id: 'b' };
        expect(sessionModels({ turns: [{ model: a }, { model: b }, { model: a }, { model: null }] }))
            .toEqual([a, b]);
    });
});

describe('ChatUI session record', () => {
    function makeUI(model = 'z-ai/glm-5.2') {
        const ui = Object.create(ChatUI.prototype);
        ui.config = { llm_models: [{ value: 'z-ai/glm-5.2', label: 'GLM-5.2' }, { value: 'qwen3', label: 'NRP Qwen3' }] };
        ui.exportConfig = resolveExportConfig(ui.config);
        ui.messagesEl = document.createElement('div');
        ui.agent = { selectedModel: model };
        return ui;
    }
    const call = (name, args) => ({ id: 'x', type: 'function', function: { name, arguments: JSON.stringify(args) } });

    it('pairs each result with the call that produced it', () => {
        const ui = makeUI();
        ui.addMessage('user', 'q');
        ui.startTurn();
        ui.showToolProposal([call('get_schema', { dataset_id: 'a' }), call('query', { sql_query: Q })], null, 1, true);
        ui.showToolResults([
            { name: 'get_schema', success: true, source: 'local', result: 'schema' },
            { name: 'query', success: true, source: 'remote', sqlQuery: Q, result: 'rows' },
        ], 1);
        ui.endTurn('done');
        ui.addMarkdown('assistant', 'done.');
        const [t] = ui.session.turns;
        expect(t.steps.map(s => [s.name, s.args])).toEqual([['get_schema', { dataset_id: 'a' }], ['query', { sql_query: Q }]]);
        expect(t.answer).toBe('done.');
        expect(t.status).toBe('done');
    });

    it('records the model each turn started on, so a mid-session switch shows', () => {
        const ui = makeUI();
        ui.addMessage('user', 'one');
        ui.agent.selectedModel = 'qwen3';
        ui.addMessage('user', 'two');
        expect(ui.session.turns.map(t => t.model)).toEqual([
            { id: 'z-ai/glm-5.2', label: 'GLM-5.2' },
            { id: 'qwen3', label: 'NRP Qwen3' },
        ]);
    });

    it('carries a system line from between questions into the next one', () => {
        const ui = makeUI();
        ui.addMessage('user', 'one');
        ui.session.turns[0].closed = true;          // handleSend's finally
        ui.addMessage('system', 'Region drawn on map.');
        ui.addMessage('user', 'two');
        expect(ui.session.turns[1].context).toEqual([{ role: 'system', text: 'Region drawn on map.' }]);
        expect(ui.session.turns[0].notes).toEqual([]);
    });

    it('keeps an error with the question it ended', () => {
        const ui = makeUI();
        ui.addMessage('user', 'one');
        ui.startTurn();
        ui.endTurn('error');
        ui.addMessage('error', 'LLM timeout');
        expect(ui.session.turns[0].notes).toEqual([{ role: 'error', text: 'LLM timeout' }]);
        expect(ui.session.turns[0].status).toBe('error');
    });
});
