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
import { createMapTools } from './map-tools.js';
import { Agent } from './agent.js';
import { ChatUI } from './chat-ui.js';

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
        if (runtimeConfig.mcp_server_url) appConfig.mcp_url = runtimeConfig.mcp_server_url;
        if (runtimeConfig.mcp_auth_token) appConfig.mcp_auth_token = runtimeConfig.mcp_auth_token;
    }

    // If no server-provided LLM config, check for user-provided key mode
    if (!appConfig.llm_models && appConfig.llm?.user_provided) {
        const saved = loadUserLLMConfig(appConfig.llm);
        if (saved) {
            appConfig.llm_models = saved.llm_models;
            appConfig.llm_model = saved.llm_models[0]?.value;
        }
        // Flag for ChatUI to show settings button
        appConfig._userProvidedMode = true;
    }
    console.log('[main] Config loaded');

    /* ── 2. Build dataset catalog from STAC ────────────────────────────── */
    const catalog = new DatasetCatalog();
    await catalog.load(appConfig);
    console.log(`[main] Catalog loaded: ${catalog.datasets.size} collections`);

    /* ── 3. Initialise map ────────────────────────────────────────────── */
    const mapManager = new MapManager('map', {
        center: appConfig.view?.center || [-119.4, 36.8],
        zoom: appConfig.view?.zoom || 6,
    });
    await mapManager.ready;                        // wait for style to load
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

    /* ── 4. Set up MCP client ─────────────────────────────────────────── */
    const mcpUrl = appConfig.mcp_url || 'https://duckdb-mcp.nrp-nautilus.io/mcp';
    const mcpHeaders = {};
    if (appConfig.mcp_auth_token) {
        mcpHeaders['Authorization'] = `Bearer ${appConfig.mcp_auth_token}`;
    }
    const mcp = new MCPClient(mcpUrl, mcpHeaders);
    // Connect eagerly but don't block boot
    mcp.connect().catch(err => console.warn('[main] Initial MCP connect failed (will retry):', err.message));

    /* ── 5. Build tool registry ───────────────────────────────────────── */
    const toolRegistry = new ToolRegistry();

    // Register local map tools
    for (const tool of createMapTools(mapManager, catalog)) {
        toolRegistry.registerLocal(tool);
    }

    // Register remote MCP tools (lazy – tries to list, falls back silently)
    try {
        const mcpTools = await mcp.listTools();
        toolRegistry.registerRemote(mcpTools, mcp);
        console.log(`[main] ${mcpTools.length} MCP tools registered`);
    } catch (err) {
        console.warn('[main] Could not list MCP tools (will retry on first use):', err.message);
        // Manually register query tool with known schema so LLM always has it
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
        }], mcp);
    }

    /* ── 6. Build system prompt ────────────────────────────────────────── */
    const basePrompt = await fetchText('system-prompt.md');
    const catalogText = catalog.generatePromptCatalog();
    const systemPrompt = basePrompt + '\n\n' + catalogText;

    /* ── 7. Create agent ──────────────────────────────────────────────── */
    const agent = new Agent(appConfig, toolRegistry);
    agent.setSystemPrompt(systemPrompt);
    console.log('[main] Agent ready');

    /* ── 8. Create UI ─────────────────────────────────────────────────── */
    const ui = new ChatUI(agent, appConfig);
    console.log('[main] UI ready – app fully loaded');
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

const STORAGE_KEY_API = 'geo-agent-api-key';
const STORAGE_KEY_ENDPOINT = 'geo-agent-endpoint';

/**
 * Build llm_models array from localStorage + app llm config.
 * Returns null if no saved API key.
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

    return { llm_models: models };
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
