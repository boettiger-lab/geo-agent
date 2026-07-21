/**
 * main.js – Application bootstrap
 *
 * Wires all modules together:
 *   config → catalog → map → tools → agent → UI
 */

import { MCPClient } from './mcp-client.js';
import { DatasetCatalog } from './dataset-catalog.js';
import { MapManager } from './map-manager.js';
import { ToolRegistry } from './tool-registry.js';
import { createMapTools, createRenderChartTool } from './map-tools.js';
import { createGeocoder } from './geocoder.js';
import { Agent } from './agent.js';
import { ChatUI } from './chat-ui.js';
import { buildLayout, sidebarHooks } from './layout-manager.js';

async function main() {
    console.log('[main] Starting app…');

    /* ── 1. Load config files ─────────────────────────────────────────── */
    // layers-input.json: static config (catalog URL, collections, view)
    // config.json: deploy-time config with secrets (LLM models, API keys)
    const [appConfig, runtimeConfig] = await Promise.all([
        fetchJson('layers-input.json'),
        fetchJson('config.json').catch(() => null),  // optional — not present in local dev
    ]);

    // Merge: runtime config (secrets) overrides static config
    if (runtimeConfig) {
        if (runtimeConfig.llm_models) appConfig.llm_models = runtimeConfig.llm_models;
        if (runtimeConfig.llm_model) appConfig.llm_model = runtimeConfig.llm_model;
        if (runtimeConfig.transcription_model) appConfig.transcription_model = runtimeConfig.transcription_model;
        if (runtimeConfig.mcp_server_url) appConfig.mcp_url = runtimeConfig.mcp_server_url;
        if (runtimeConfig.mcp_auth_token) appConfig.mcp_auth_token = runtimeConfig.mcp_auth_token;
        if (runtimeConfig.catalog_token) appConfig.catalog_token = runtimeConfig.catalog_token;
        if (runtimeConfig.draw_enabled != null) appConfig.draw_enabled = runtimeConfig.draw_enabled;
        if (runtimeConfig.geolocate != null) appConfig.geolocate = runtimeConfig.geolocate;
        // != null (not truthiness) so 0 — which disables the checkpoint — survives.
        if (runtimeConfig.max_tool_calls != null) appConfig.max_tool_calls = runtimeConfig.max_tool_calls;
        if (runtimeConfig.max_tool_calls_manual != null) appConfig.max_tool_calls_manual = runtimeConfig.max_tool_calls_manual;
    }

    // If no server-provided LLM config, check for user-provided key mode
    if (!appConfig.llm_models && appConfig.llm?.user_provided) {
        const saved = loadUserLLMConfig(appConfig.llm);
        if (saved) {
            appConfig.llm_models = saved.llm_models;
            appConfig.llm_model = saved.llm_models[0]?.value;
            if (saved.transcription_model) appConfig.transcription_model = saved.transcription_model;
        }
        // Flag for ChatUI to show settings button
        appConfig._userProvidedMode = true;
    }
    console.log('[main] Config loaded');

    /* ── 1b. Build UI chrome (layout-manager owns floating vs sidebar) ─── */
    const layoutRefs = buildLayout(appConfig);

    /* ── 1c. Kick off independent network I/O so it overlaps ──────────────
     * MCP cold-start, the STAC catalog walk, the map style, and the static
     * system-prompt fetch are mutually independent. Fire the slow ones now and
     * await them together below, instead of serializing each round trip. */
    const mcpUrl = appConfig.mcp_url || 'https://duckdb-mcp.nrp-nautilus.io/mcp';
    const mcpHeaders = {};
    if (appConfig.mcp_auth_token) {
        mcpHeaders['Authorization'] = `Bearer ${appConfig.mcp_auth_token}`;
    }
    console.log('[main] MCP URL:', mcpUrl, 'auth token present:', !!appConfig.mcp_auth_token);
    const mcp = new MCPClient(mcpUrl, mcpHeaders);
    // Connect eagerly but don't block boot — overlaps catalog + map load below.
    mcp.connect().catch(err => console.warn('[main] Initial MCP connect failed (will retry):', err.message));
    // Static system-prompt fetch (awaited at step 6) — independent of everything.
    const basePromptP = fetchText('system-prompt.md');

    /* ── 2+3. Build dataset catalog + map, loaded in parallel ──────────── */
    const catalog = new DatasetCatalog();
    const mapManager = new MapManager('map', {
        center: appConfig.view?.center || [-119.4, 36.8],
        zoom: appConfig.view?.zoom || 6,
        pitch: appConfig.view?.pitch ?? 0,
        bearing: appConfig.view?.bearing ?? 0,
        globe: appConfig.view?.globe ?? false,
        titilerUrl: appConfig.titiler_url || 'https://titiler.nrp-nautilus.io',
        maptilerKey: runtimeConfig?.maptiler_key || '',
        defaultBasemap: appConfig.default_basemap || 'natgeo',
        customBasemap: appConfig.custom_basemap || null,
    });
    // STAC walk and map-style load run concurrently (the MapManager constructor
    // already kicked off the style fetch); wait for both before wiring layers.
    await Promise.all([catalog.load(appConfig), mapManager.ready]);
    console.log(`[main] Catalog loaded: ${catalog.datasets.size} collections`);
    // Sidebar resize: reflow the MapLibre canvas during drag (rAF-gated by
    // layout-manager) and one final time on drag-end / window-resize.
    sidebarHooks.onResizeTick = () => mapManager.map.resize();
    sidebarHooks.onResizeEnd = () => mapManager.map.resize();
    mapManager.generateMenu(layoutRefs.menuMountId);
    mapManager.addLayersFromCatalog(catalog.getMapLayerConfigs());
    mapManager.generateControls('layer-controls-container');
    console.log('[main] Map ready');

    /* ── 3b. H3 hex-grid toggle (optional — requires h3-js global) ──── */
    if (typeof h3 !== 'undefined') {
        const { H3DynamicLayer } = await import('./h3geo.js');
        const h3Layer = new H3DynamicLayer(mapManager.map, {
            fillColor: '#007cbf',
            fillOpacity: 0.05,
            outlineColor: '#333333',
            outlineWidth: 1,
            outlineOpacity: 0.35,
        });

        // Create toggle button
        const btn = document.createElement('button');
        btn.id = 'h3-toggle';
        btn.title = 'Toggle H3 hex grid';
        btn.innerHTML = '⬡';
        document.body.appendChild(btn);

        // Resolution badge (hidden until active)
        const badge = document.createElement('span');
        badge.id = 'h3-res-badge';
        badge.style.display = 'none';
        document.body.appendChild(badge);

        let h3Active = false;
        btn.addEventListener('click', () => {
            h3Active = !h3Active;
            if (h3Active) {
                h3Layer.start();
                btn.classList.add('active');
                badge.style.display = '';
            } else {
                h3Layer.stop();
                btn.classList.remove('active');
                badge.style.display = 'none';
            }
        });

        // Update badge on hex refresh
        window.addEventListener('h3update', (e) => {
            badge.textContent = `${e.detail.resolution}`;
        });

        console.log('[main] H3 grid toggle ready');
    }

    /* ── 3c. Polygon draw tool (optional — requires draw_enabled) ───── */
    let mapDraw = null;
    if (appConfig.draw_enabled) {
        try {
            const { MapDraw } = await import('./map-draw.js');
            mapDraw = new MapDraw(mapManager.map);
            await mapDraw.init();
            console.log('[main] Draw tool ready');
        } catch (err) {
            console.warn('[main] Failed to load draw module:', err.message);
        }
    }

    /* ── 3c-bis. GeoJSON upload (optional — requires upload_enabled) ─── */
    // Off by default. `upload_enabled: true` uses defaults; an object customizes
    // the bucket/prefix/caps/ingest link (see upload-manager.js). The upload
    // goes browser → S3 directly; only the resulting URL reaches the agent, via
    // the get_uploaded_dataset tool below (geo-agent#325).
    let uploadManager = null;
    if (appConfig.upload_enabled) {
        try {
            const { UploadManager } = await import('./upload-manager.js');
            const uploadCfg = (appConfig.upload_enabled && typeof appConfig.upload_enabled === 'object')
                ? appConfig.upload_enabled
                : (appConfig.upload || {});
            uploadManager = new UploadManager(mapManager, uploadCfg);
            uploadManager.init();
            console.log('[main] Upload tool ready');
        } catch (err) {
            console.warn('[main] Failed to load upload module:', err.message);
        }
    }

    /* ── 3d. Geolocation (optional — "where am I?") ──────────────────── */
    // Two independently opt-in surfaces, both off by default:
    //   • locate-me button (UI)        — geolocate.button
    //   • get_user_location agent tool — geolocate.agent_tool (reaches device
    //     GPS, so off by default even though it's invisible — see map-tools.js)
    // `geolocate: true` is back-compat shorthand for { button: true }.
    const geoLocCfg = appConfig.geolocate === true
        ? { button: true }
        : (appConfig.geolocate && typeof appConfig.geolocate === 'object')
            ? appConfig.geolocate
            : {};
    // GeolocateControl ships with MapLibre GL JS, so there's nothing to pin.
    if (geoLocCfg.button) {
        try {
            mapManager.map.addControl(
                new maplibregl.GeolocateControl({
                    positionOptions: { enableHighAccuracy: true },
                    trackUserLocation: true,
                    showUserLocation: true,
                }),
                'top-left',
            );
            console.log('[main] Geolocate control ready');
        } catch (err) {
            console.warn('[main] Failed to add geolocate control:', err.message);
        }
    }

    /* ── 5. Build tool registry ───────────────────────────────────────── */
    // Idempotent-read memoization (#281) is on by default; set `tool_memo: false`
    // in config to disable it (e.g. for debugging duplicate MCP traffic).
    const toolRegistry = new ToolRegistry(
        appConfig.tool_memo === false ? { memoTools: [] } : {},
    );

    // Geocoder backend, shared by two independently-toggled surfaces:
    //   • the `geocode` agent tool — ON by default (opt-out: geocoder.enabled=false)
    //   • the on-map search box — OFF by default (opt-in: geocoder.search_box=true)
    // The backend is built when either surface needs it. The MapTiler key, when
    // present, falls back to the basemap key.
    const geoCfg = appConfig.geocoder || {};
    const geocodeToolEnabled = geoCfg.enabled !== false;
    let geocoder = null;
    if (geocodeToolEnabled || geoCfg.search_box) {
        try {
            geocoder = createGeocoder({
                ...geoCfg,
                maptiler_key: geoCfg.maptiler_key || runtimeConfig?.maptiler_key,
            });
        } catch (err) {
            console.warn('[main] Geocoder disabled — invalid config:', err.message);
        }
    }

    // Optional on-map search box, sharing the same geocoder backend.
    if (geocoder && geoCfg.search_box) {
        try {
            const { addSearchBox } = await import('./map-geocoder.js');
            await addSearchBox(mapManager.map, geocoder, {
                position: geoCfg.search_box_position,
                placeholder: geoCfg.search_box_placeholder,
            });
            console.log('[main] Search box ready');
        } catch (err) {
            console.warn('[main] Failed to load search box:', err.message);
        }
    }

    // Register local map tools. The geocode tool is gated on geocodeToolEnabled
    // (not merely on the backend existing), so search_box can run without it.
    // get_user_location is gated separately on the opt-in geolocate.agent_tool.
    for (const tool of createMapTools(mapManager, catalog, mcp, geocodeToolEnabled ? geocoder : null, { geolocateTool: !!geoLocCfg.agent_tool })) {
        toolRegistry.registerLocal(tool);
    }

    // Register draw tool (if draw is enabled and loaded)
    if (mapDraw) {
        toolRegistry.registerLocal({
            name: 'get_drawn_region',
            description:
                'Get the polygon region the user drew on the map, as WKT. ' +
                'Returns the WKT geometry and a suggested H3 resolution based on the region size. ' +
                'To use in SQL: UNNEST(h3_polygon_wkt_to_cells(wkt, resolution)) produces H3 cells ' +
                'that can be JOINed against a dataset\'s H3 index column. Use the resolution ' +
                'closest to (but not exceeding) the suggested resolution. ' +
                'Returns null if no region is drawn. Call this when the user says ' +
                '"this area", "here", "my selection", "the drawn region", or similar.',
            inputSchema: {
                type: 'object',
                properties: {},
            },
            execute: () => {
                const wkt = mapDraw.getRegionWKT();
                if (!wkt) {
                    return JSON.stringify({
                        success: false,
                        error: 'No region drawn. Ask the user to draw a polygon on the map first.',
                    });
                }
                return JSON.stringify({
                    success: true,
                    wkt,
                    suggested_h3_resolution: mapDraw.getSuggestedH3Resolution(),
                    hint: 'To filter by this region, UNNEST h3_polygon_wkt_to_cells(wkt, resolution) and JOIN on the dataset H3 column. ' +
                          'Example: FROM UNNEST(h3_polygon_wkt_to_cells(\'<wkt>\', <res>)) AS t(cell) JOIN data ON data.h3_col = t.cell. ' +
                          'suggested_h3_resolution is a ceiling — pick the dataset H3 column closest to but not exceeding it.',
                });
            },
        });
    }

    // Register uploaded-dataset tool (if upload is enabled and loaded). Returns
    // only the S3 URL(s) of user-uploaded boundaries — the geometry itself never
    // enters the model's context. The agent reads the file server-side via the
    // spatial `query` tool and uses it as a mask (geo-agent#325).
    if (uploadManager) {
        toolRegistry.registerLocal({
            name: 'get_uploaded_dataset',
            description:
                'Get the polygon boundary/boundaries the user uploaded to the map, as public GeoJSON URL(s). ' +
                'The agent does NOT receive the geometry — read it server-side in the query tool with ' +
                'ST_Read(url) and use it as an area-of-interest mask. ' +
                'Call this when the user refers to "the uploaded file", "my boundary", "the shape I added", ' +
                '"this area", or asks a spatial question about an uploaded region. Returns success:false if nothing is uploaded.',
            inputSchema: { type: 'object', properties: {} },
            execute: () => {
                const uploads = uploadManager.getUploads();
                if (!uploads.length) {
                    return JSON.stringify({ success: false, error: 'No uploaded dataset. Ask the user to upload a polygon GeoJSON first.' });
                }
                return JSON.stringify({
                    success: true,
                    datasets: uploads.map(u => ({
                        url: u.url,
                        display_name: u.displayName,
                        geometry_type: u.geometryType,
                        feature_count: u.featureCount,
                        property_keys: u.propertyKeys,
                    })),
                    hint:
                        "Read a boundary server-side, never inline its geometry. For a spatial mask: " +
                        "WITH aoi AS (SELECT ST_Union_Agg(geom) AS g FROM ST_Read('<url>')) " +
                        "SELECT ... FROM data, aoi WHERE ST_Within(data.geom, aoi.g). " +
                        "For an H3-indexed dataset, convert once to cells and JOIN: " +
                        "WITH aoi AS (SELECT ST_AsText(ST_Union_Agg(geom)) AS wkt FROM ST_Read('<url>')) " +
                        "SELECT d.* FROM aoi, UNNEST(h3_polygon_wkt_to_cells(aoi.wkt, <res>)) AS t(cell) JOIN data d ON d.<h3_col> = t.cell. " +
                        "Pick <res> to keep cell counts reasonable (coarser for large areas).",
                });
            },
        });
    }

    // Opt-in charting primitive (#277). Off by default: the render_chart tool
    // and the Observable Plot CDN load only exist when `charts.enabled` is set,
    // so apps that don't want charts pay nothing.
    if (appConfig.charts?.enabled) {
        try {
            const { ChartRenderer } = await import('./chart-renderer.js');
            const chartRenderer = new ChartRenderer();
            toolRegistry.registerLocal(createRenderChartTool(chartRenderer, mcp));
            console.log('[main] Charting enabled (render_chart tool registered)');
        } catch (err) {
            console.warn('[main] Failed to enable charting:', err.message);
        }
    }

    // Inline cached STAC content on LLM-issued direct calls to in-app data,
    // mirroring what the local get_schema delegate does (see #192). Skips an
    // upstream fetch on the MCP side. Foreign-catalog calls pass through.
    const injectInlineStac = (toolName, args) => {
        if (!args) return args;
        if (args.catalog_url && args.catalog_url !== catalog.catalogUrl) return args;
        let id = null;
        if (toolName === 'get_stac_details') id = args.dataset_id;
        else if (toolName === 'get_collection') id = args.collection_id;
        if (!id) return args;
        const collection = catalog.toStacDict(id);
        if (!collection) return args;
        return { ...args, collection };
    };

    // Register remote MCP tools. The initial listTools() can time out when
    // the MCP pod is cold-starting; retry a few times before falling back to
    // a minimal hardcoded `query` tool. If the fallback fires, the
    // onReconnect hook below will refresh the registry once the transport
    // finally connects.
    const listMcpToolsWithRetry = async (attempts = 3) => {
        let lastErr;
        for (let i = 0; i < attempts; i++) {
            try {
                // connect() dedupes with the eager connect fired at boot and
                // caches the tool list internally, so getTools() avoids the
                // extra listTools() round trip the old path incurred.
                await mcp.connect();
                const tools = mcp.getTools();
                // An empty list here means the connect resolved before its tool
                // cache was populated — treat it as a failure so we retry, and
                // fall back to the hardcoded `query` tool rather than silently
                // registering zero MCP tools for the life of the session.
                if (!tools.length) throw new Error('MCP connected but returned an empty tool list');
                return tools;
            } catch (err) {
                lastErr = err;
                const delay = Math.min(2000 * Math.pow(2, i), 8000);
                console.warn(`[main] MCP connect attempt ${i + 1}/${attempts} failed: ${err.message}`);
                if (i < attempts - 1) await new Promise(r => setTimeout(r, delay));
            }
        }
        throw lastErr;
    };

    mcp.setOnReconnect((tools) => {
        toolRegistry.clearRemote();
        toolRegistry.registerRemote(tools, mcp, injectInlineStac);
        console.log(`[main] Refreshed MCP tools after reconnect: ${tools.length} tools`);
    });

    try {
        const mcpTools = await listMcpToolsWithRetry();
        toolRegistry.registerRemote(mcpTools, mcp, injectInlineStac);
        console.log(`[main] ${mcpTools.length} MCP tools registered`);
    } catch (err) {
        console.warn('[main] Could not list MCP tools after retries (will refresh on reconnect):', err.message);
        // Hardcoded fallback so the LLM always has at least the query tool.
        // The onReconnect hook replaces this entry once the transport connects.
        toolRegistry.registerRemote([{
            name: 'query',
            description: 'Execute a read-only SQL query against a DuckDB database that is pre-loaded with H3 geospatial extensions, spatial functions, and httpfs for accessing remote parquet data. The database supports partitioned hive-style parquet files on S3.',
            inputSchema: {
                type: 'object',
                properties: {
                    sql_query: {
                        type: 'string',
                        description: 'The SQL query to execute. Must be a read-only SELECT statement.'
                    }
                },
                required: ['sql_query']
            }
        }], mcp, injectInlineStac);
    }

    /* ── 6. Build system prompt ────────────────────────────────────────── */
    const basePrompt = await basePromptP;   // fetch was kicked off at step 1c
    // Large catalogs (#294) switch to a compact index to shrink the cold prompt;
    // tune or disable the threshold with `catalog_index_threshold` (Infinity = always full).
    const catalogText = catalog.generatePromptCatalog({ compactAbove: appConfig.catalog_index_threshold ?? 8 });
    let systemPrompt = basePrompt + '\n\n' + catalogText;

    // Read server-provided prompt (if any)
    try {
        const prompts = await mcp.listPrompts();
        const analyst = prompts?.find(p => p.name === 'geospatial-analyst');
        if (analyst) {
            const content = await mcp.getPrompt(analyst.name);
            if (content) {
                systemPrompt += '\n\n' + content;
                console.log('[main] Loaded MCP geospatial-analyst prompt');
            }
        }
    } catch (e) {
        console.warn('[main] No MCP prompts available:', e.message);
    }

    /* ── 7. Create agent ──────────────────────────────────────────────── */
    const agent = new Agent(appConfig, toolRegistry);
    agent.setSystemPrompt(systemPrompt);
    console.log('[main] Agent ready');

    /* ── 8. Create UI ─────────────────────────────────────────────────── */
    const ui = new ChatUI(agent, appConfig, layoutRefs.chatMount);

    // Draw event → chat notifications.
    // Replace (not append) synthetic draw messages so repeated draw/clear
    // cycles don't bloat the agent's conversation history.
    if (mapDraw) {
        const DRAW_PREFIX = '[The user has drawn a region';
        const CLEAR_PREFIX = '[The user has cleared the drawn region';
        function replaceDrawMessage(content) {
            for (let i = agent.messages.length - 1; i >= 0; i--) {
                const c = agent.messages[i].content;
                if (agent.messages[i].role === 'user' &&
                    (c.startsWith(DRAW_PREFIX) || c.startsWith(CLEAR_PREFIX))) {
                    agent.messages.splice(i, 1);
                }
            }
            agent.messages.push({ role: 'user', content });
        }

        window.addEventListener('region-drawn', () => {
            ui.addMessage('system', 'Region drawn on map. Ask me anything about this area.');
            replaceDrawMessage(
                '[The user has drawn a region of interest on the map. ' +
                'Use the get_drawn_region tool to retrieve the polygon when answering spatial queries about this area.]',
            );
        });
        window.addEventListener('region-cleared', () => {
            ui.addMessage('system', 'Region cleared.');
            replaceDrawMessage(
                '[The user has cleared the drawn region from the map.]',
            );
        });
    }

    // Upload event → chat notification + a nudge so the agent knows an
    // uploaded boundary is available (it fetches the URL via get_uploaded_dataset).
    if (uploadManager) {
        window.addEventListener('geojson-uploaded', (e) => {
            const name = e.detail?.displayName || 'a boundary';
            ui.addMessage('system', `Uploaded "${name}" to the map. Ask me anything about this area.`);
            agent.messages.push({
                role: 'user',
                content: '[The user has uploaded a polygon boundary to the map. ' +
                    'Use the get_uploaded_dataset tool to retrieve its URL when answering spatial queries about this area.]',
            });
        });
        window.addEventListener('geojson-upload-error', (e) => {
            ui.addMessage('system', `Upload failed: ${e.detail?.message || 'unknown error'}`);
        });
    }

    console.log('[main] UI ready – app fully loaded');
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

const STORAGE_KEY_API = 'geo-agent-api-key';
const STORAGE_KEY_ENDPOINT = 'geo-agent-endpoint';

/**
 * Build llm_models array (and optionally transcription_model) from
 * localStorage + app llm config. Returns null if no saved API key.
 */
function loadUserLLMConfig(llmConfig) {
    const apiKey = localStorage.getItem(STORAGE_KEY_API);
    if (!apiKey) return null;

    const endpoint = localStorage.getItem(STORAGE_KEY_ENDPOINT)
        || llmConfig.default_endpoint
        || 'https://openrouter.ai/api/v1';

    const models = (llmConfig.models || []).map(m => ({
        ...m,
        endpoint,
        api_key: apiKey,
    }));

    // If no models configured, create a generic one
    if (models.length === 0) {
        models.push({
            value: 'auto',
            label: 'Auto',
            endpoint,
            api_key: apiKey,
        });
    }

    const result = { llm_models: models };

    // Transcription model for voice input — inherits the user's key and
    // (by default) the same endpoint. Either can be overridden per entry.
    if (llmConfig.transcription_model?.value) {
        result.transcription_model = {
            ...llmConfig.transcription_model,
            endpoint: llmConfig.transcription_model.endpoint || endpoint,
            api_key: llmConfig.transcription_model.api_key || apiKey,
        };
    }

    return result;
}

async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    return res.json();
}

async function fetchText(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    return res.text();
}

/* ── Boot ───────────────────────────────────────────────────────────────── */

main().catch(err => {
    console.error('[main] Fatal boot error:', err);
    const msg = document.getElementById('chat-messages');
    if (msg) {
        msg.innerHTML = `<div class="chat-message error">Failed to start: ${err.message}</div>`;
    }
});
