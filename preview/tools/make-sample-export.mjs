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
import { writeFileSync } from 'node:fs';
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
                   'MutationObserver', 'requestAnimationFrame', 'localStorage']) {
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

/* ── The map, as the app would have captured it ─────────────────────────── */

const mapState = {
    center: [-119.9, 37.1],
    zoom: 5.2,
    bearing: 0,
    pitch: 0,
    projection: 'mercator',
    style: {
        version: 8,
        glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
        sources: {
            natgeo: {
                type: 'raster',
                tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/NatGeo_World_Map/MapServer/tile/{z}/{y}/{x}'],
                tileSize: 256,
                maxzoom: 16,
                attribution: 'Tiles &copy; Esri &mdash; National Geographic, Esri, DeLorme, NAVTEQ, UNEP-WCMC, USGS, NASA, ESA, METI, NRCAN, GEBCO, NOAA',
            },
            'cpad-holdings': {
                type: 'vector',
                url: 'pmtiles://https://s3-west.nrp-nautilus.io/public-cpad/cpad-2025b-holdings.pmtiles',
            },
        },
        layers: [
            { id: 'natgeo-base', type: 'raster', source: 'natgeo' },
            {
                id: 'cpad-holdings-fill', type: 'fill',
                source: 'cpad-holdings', 'source-layer': 'cpad-2025b-holdings',
                paint: { 'fill-color': '#2e7d32', 'fill-opacity': 0.45 },
            },
            {
                id: 'cpad-holdings-line', type: 'line',
                source: 'cpad-holdings', 'source-layer': 'cpad-2025b-holdings',
                paint: { 'line-color': '#1b5e20', 'line-width': 0.3 },
            },
        ],
    },
};

/* ── The transcript ─────────────────────────────────────────────────────── */

const COUNTY_SQL = `SELECT COUNTY,
       round(sum(ACRES)) AS protected_acres,
       count(*)          AS holdings
FROM read_parquet('s3://public-cpad/cpad-2025b-holdings.parquet')
GROUP BY COUNTY
ORDER BY protected_acres DESC
LIMIT 6`;

const COUNTY_RESULT = `COUNTY          | protected_acres | holdings
----------------+-----------------+---------
San Bernardino  |       8538419.0 |    24181
Inyo            |       5978897.0 |     3092
Riverside       |       2970879.0 |    15584
Siskiyou        |       2587554.0 |     5744
Mono            |       1882239.0 |     4018
Lassen          |       1770843.0 |     1311

6 rows`;

// The globbed path is the point of #367: it must reach the reader intact.
const RICHNESS_SQL = `SELECT round(avg(mammals_sr), 1) AS mean_species,
       max(mammals_sr)            AS max_species,
       count(*)                   AS hex_cells
FROM read_parquet('s3://public-iucn/hex/mammals_sr/h0=*/data_0.parquet')`;

const RICHNESS_RESULT = `mean_species | max_species | hex_cells
-------------+-------------+----------
        31.1 |       213.0 |  1964322

1 row`;

const ui = Object.create(ChatUI.prototype);
ui.config = { export: { public_s3_endpoint: 's3-west.nrp-nautilus.io' } };
ui.exportConfig = resolveExportConfig(ui.config);
ui.messagesEl = window.document.createElement('div');
ui.messagesEl.id = 'chat-messages';
ui.mapManager = { getExportState: () => mapState };
window.document.body.appendChild(ui.messagesEl);

function toolCall(id, name, args) {
    return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

// ── Turn 1 — protected acreage by county
ui.addMessage('user', 'Which California counties hold the most protected land?');
ui.startTurn();
ui.showToolProposal([toolCall('c1', 'query', { sql: COUNTY_SQL })],
    'Summing CPAD holding acreage by county.', 1, true);
ui.showToolResults([{
    name: 'query', success: true, source: 'remote',
    sqlQuery: COUNTY_SQL, result: COUNTY_RESULT,
}], 1);
ui.endTurn('done');
ui.addMarkdown('assistant', `**San Bernardino County leads by a wide margin** — 8.5 million protected acres, nearly a third more than every other county in the top six combined would suggest at first glance.

| County | Protected acres | Holdings |
|---|---:|---:|
| San Bernardino | 8,538,419 | 24,181 |
| Inyo | 5,978,897 | 3,092 |
| Riverside | 2,970,879 | 15,584 |
| Siskiyou | 2,587,554 | 5,744 |
| Mono | 1,882,239 | 4,018 |
| Lassen | 1,770,843 | 1,311 |

Note the difference in *holding counts*: Inyo reaches 6 million acres across 3,092 holdings, while Riverside needs 15,584 holdings for half that. Desert and mountain counties are protected in large federal blocks; coastal and valley counties in many small parcels.`);

// ── Turn 2 — species richness, and a map restyle
ui.addMessage('user', 'How does mammal species richness vary across the hex grid? Shade the protected areas darker while you are at it.');
ui.startTurn();
ui.showToolProposal([
    toolCall('c2', 'query', { sql: RICHNESS_SQL }),
    toolCall('c3', 'set_layer_style', { layer: 'cpad-holdings', fill_color: '#1b5e20', fill_opacity: 0.55 }),
], 'Reading the IUCN mammal richness hexes, then restyling the CPAD layer.', 2, true);
ui.showToolResults([
    { name: 'query', success: true, source: 'remote', sqlQuery: RICHNESS_SQL, result: RICHNESS_RESULT },
    { name: 'set_layer_style', success: true, source: 'local', result: 'Styled cpad-holdings: fill #1b5e20 at 0.55 opacity.' },
], 2);
ui.endTurn('done');
ui.addMarkdown('assistant', `Across all **1,964,322** H3 cells with data, mammal richness averages **31.1 species**, peaking at **213** in the wettest tropical cells. California's own cells sit well above the global mean without approaching that ceiling.

The protected-area layer is now darker green, so the richness surface reads through it.`);

/* ── Export ─────────────────────────────────────────────────────────────── */

ui.exportHtml();
if (!captured) throw new Error('export produced no output');
writeFileSync(OUT, captured);
console.log(`wrote ${OUT} (${(captured.length / 1024).toFixed(1)} KB)`);
