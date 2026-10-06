// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { sqlArg, REMOTE_SQL_ARGS, LOCAL_SQL_ARGS, ToolRegistry } from '../app/tool-registry.js';
import { stepSql, classifyStep, buildReportHtml, buildSessionFiles, sessionDatasets } from '../app/export-report.js';
import { ChatUI } from '../app/chat-ui.js';

/**
 * Which argument holds a tool call's SQL — one rule (sqlArg), applied at every
 * site that reads it. Before this, four sites each kept their own list: the
 * registry and the export missed the `sql` alias (ca-30x30, v3.34.0: the
 * query landed in "Consulted" and the export lost its download buttons), and
 * the chat panel read a local `query` (geocode's place name) as SQL.
 *
 * The remote names mirror mcp-data-server: `query` takes `sql_query`,
 * `register_hex_tiles` takes `sql`, and each accepts the other (#321).
 */

const SQL = "SELECT count(*) AS n FROM read_parquet('s3://public-x/hex/h0=*/data_0.parquet')";
const REMOTE_TOOLS = ['query', 'register_hex_tiles'];

describe('sqlArg', () => {
    it('finds the SQL under every name the MCP server accepts', () => {
        expect(REMOTE_SQL_ARGS).toEqual(['sql_query', 'sql', 'query']);
        for (const key of REMOTE_SQL_ARGS) {
            expect(sqlArg({ [key]: SQL }, true)).toEqual({ key, sql: SQL });
        }
    });

    it('prefers the canonical name when several are present', () => {
        expect(sqlArg({ query: 'c', sql: 'b', sql_query: 'a' }, true)).toEqual({ key: 'sql_query', sql: 'a' });
        expect(sqlArg({ query: 'c', sql: 'b' }, true)).toEqual({ key: 'sql', sql: 'b' });
    });

    it('reads only `sql` for a local tool — a local `query` is a place name', () => {
        expect(LOCAL_SQL_ARGS).toEqual(['sql']);
        expect(sqlArg({ sql: SQL }, false)).toEqual({ key: 'sql', sql: SQL });
        expect(sqlArg({ query: 'Yosemite' }, false)).toBe(null);
        expect(sqlArg({ sql_query: SQL }, false)).toBe(null);
    });

    it('skips empty and non-string values, and tolerates junk args', () => {
        expect(sqlArg({ sql_query: '   ', sql: SQL }, true)).toEqual({ key: 'sql', sql: SQL });
        expect(sqlArg({ sql_query: 42 }, true)).toBe(null);
        expect(sqlArg(null, true)).toBe(null);
        expect(sqlArg('SELECT 1', true)).toBe(null);
    });
});

describe('every site applies the one rule', () => {
    const remoteReg = () => {
        const reg = new ToolRegistry();
        reg.registerRemote(REMOTE_TOOLS.map(name => ({ name, description: '', inputSchema: { type: 'object', properties: {} } })),
            { callTool: async () => 'rows' });
        reg.registerLocal({ name: 'geocode', description: '', inputSchema: { type: 'object', properties: {} }, execute: () => 'ok' });
        return reg;
    };

    it('registry: records sqlQuery for every remote tool under every name', async () => {
        const reg = remoteReg();
        for (const tool of REMOTE_TOOLS) {
            for (const key of REMOTE_SQL_ARGS) {
                expect((await reg.execute(tool, { [key]: SQL })).sqlQuery, `${tool}/${key}`).toBe(SQL);
            }
        }
    });

    it('chat panel: shows SQL for every remote name, and not for geocode', () => {
        const ui = Object.create(ChatUI.prototype);
        ui.agent = { toolRegistry: remoteReg() };
        const sqlShown = (name, args) => {
            const el = document.createElement('div');
            el.innerHTML = ui.renderToolCallArgs({ function: { name, arguments: JSON.stringify(args) } });
            return el.querySelector('.sql-detail code')?.textContent ?? null;
        };
        for (const tool of REMOTE_TOOLS) {
            for (const key of REMOTE_SQL_ARGS) expect(sqlShown(tool, { [key]: SQL }), `${tool}/${key}`).toBe(SQL);
        }
        expect(sqlShown('geocode', { query: 'Yosemite' })).toBe(null);
        expect(ui.describeToolCalls([{ function: { name: 'geocode', arguments: '{"query":"Yosemite"}' } }]))
            .toBe('Will call `geocode`.');
    });

    it('chat panel: lists the other args without the SQL arg, whatever its name', () => {
        const ui = Object.create(ChatUI.prototype);
        const el = document.createElement('div');
        el.innerHTML = ui.renderToolCallArgs({ function: { name: 'register_hex_tiles',
            arguments: JSON.stringify({ sql: SQL, agg: 'COUNT' }) } });
        const others = [...el.querySelectorAll('pre code')].map(c => c.textContent).find(t => t.includes('agg'));
        expect(others).toContain('"agg": "COUNT"');
        expect(others).not.toContain('read_parquet');
    });
});

describe('the export, under every name', () => {
    // A step as ChatUI records it from a live session. `recorded` is the
    // registry's sqlQuery, which older builds left unset for `sql`.
    const step = (name, args, source = 'remote', recorded = undefined) => ({
        name, args, source, success: true, result: '| n |\n|---|\n| 3 |',
        ...(recorded ? { sqlQuery: recorded } : {}),
    });
    const turn = (steps) => ({ prompt: 'q', model: { id: 'm' }, startedAt: '2026-10-06T19:00:00Z',
        status: 'done', steps, answer: 'Three.', notes: [] });
    const reportDoc = (steps) => {
        const html = buildReportHtml({ turns: [turn(steps)] }, { basename: 'b', exportedAt: new Date('2026-10-06T20:00:00Z') });
        const doc = document.implementation.createHTMLDocument('r');
        doc.documentElement.innerHTML = html.replace(/^[\s\S]*?<html[^>]*>/i, '').replace(/<\/html>[\s\S]*$/i, '');
        return doc;
    };

    for (const tool of REMOTE_TOOLS) {
        for (const key of REMOTE_SQL_ARGS) {
            it(`${tool} with {${key}}: a chunk, the downloads, and the SQL in every file`, () => {
                // Not relying on the registry's sqlQuery: a session recorded by
                // an older build has args only.
                const s = step(tool, { [key]: SQL });
                expect(stepSql(s)).toBe(SQL);
                expect(classifyStep(s)).toBe('chunk');

                const doc = reportDoc([s]);
                expect(doc.querySelectorAll('main .chunk').length).toBe(1);
                expect(doc.querySelector('main .code-variant[data-lang="sql"]').textContent).toBe(SQL);
                expect(doc.querySelectorAll('.export-download-controls button').length).toBe(4);
                expect(doc.querySelector('.report-consulted')).toBe(null);

                for (const f of buildSessionFiles({ turns: [turn([s])] })) {
                    expect(f.text, f.filename).toContain('read_parquet');
                    expect(f.text, f.filename).toContain('public-x/hex');
                }
            });
        }
    }

    it('local render_chart / filter_by_query with {sql}: a chunk', () => {
        for (const tool of ['render_chart', 'filter_by_query']) {
            expect(stepSql(step(tool, { sql: SQL }, 'local')), tool).toBe(SQL);
        }
    });

    it('local geocode with {query}: not SQL, not a chunk, no downloads', () => {
        const s = step('geocode', { query: 'Yosemite' }, 'local');
        expect(stepSql(s)).toBe(null);
        expect(classifyStep(s)).toBe('map');
        expect(reportDoc([s]).querySelector('.export-download-controls')).toBe(null);
    });

    it('cites the dataset a query read, whichever name carried the SQL', () => {
        const stac = { id: 'x', title: 'X', license: 'CC-BY-4.0', providers: [], links: [],
            assets: { h: { href: 'https://s3-west.nrp-nautilus.io/public-x/hex/h0=*/data_0.parquet', type: 'application/vnd.apache.parquet' } } };
        for (const key of REMOTE_SQL_ARGS) {
            const ds = sessionDatasets({ turns: [turn([step('query', { [key]: SQL })])] }, [{ id: 'x', _rawStac: stac }]);
            expect(ds.map(d => d.id), key).toEqual(['x']);
        }
    });
});
