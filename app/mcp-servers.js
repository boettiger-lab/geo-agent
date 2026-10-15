/**
 * Which MCP servers an app connects to (#338).
 *
 * Pure config resolution — no transport, no DOM — so it is testable without
 * the SDK. main.js builds one MCPClient per entry this returns.
 *
 * Two config shapes:
 *   - `mcp_url` (+ `mcp_auth_token`): the single-server shorthand every
 *     existing app uses.
 *   - `mcp_servers: [{ url, auth_token?, optional? }, …]`: several servers.
 *
 * The first entry is the PRIMARY server — the data engine (duckdb-mcp). Only
 * the primary gets the inline-STAC rewriter, the fallback `query` tool, the
 * `geospatial-analyst` prompt, and the local tools that delegate to it
 * (get_schema, render_chart's sql path). The legacy keys always address the
 * primary: `mcp_url` (and config.json's `mcp_server_url`, merged into it)
 * replaces the primary's URL, and `mcp_auth_token` its token. Every other
 * entry is left as configured, so a deployment that injects `mcp_server_url`
 * keeps the extra servers listed in `layers-input.json`.
 */

export const DEFAULT_MCP_URL = 'https://duckdb-mcp.nrp-nautilus.io/mcp';

/**
 * @typedef {Object} McpServerConfig
 * @property {string} url
 * @property {Object<string,string>} headers - per-server request headers (auth)
 * @property {boolean} optional - a failed connection drops only this server's tools
 * @property {boolean} primary - first entry; see module comment
 */

/**
 * @param {Object} appConfig - merged layers-input.json + config.json
 * @returns {McpServerConfig[]} never empty
 */
export function resolveMcpServers(appConfig = {}) {
    const listed = Array.isArray(appConfig.mcp_servers)
        ? appConfig.mcp_servers.filter(s => {
            const ok = s && typeof s.url === 'string' && s.url.trim();
            if (!ok) console.warn('[main] Ignoring mcp_servers entry without a url:', s);
            return ok;
        })
        : [];
    const entries = listed.length ? listed.map(s => ({ ...s })) : [{}];

    // Legacy keys address the primary only.
    if (appConfig.mcp_url) entries[0].url = appConfig.mcp_url;
    if (appConfig.mcp_auth_token) entries[0].auth_token = appConfig.mcp_auth_token;
    if (!entries[0].url) entries[0].url = DEFAULT_MCP_URL;

    return entries.map((s, i) => ({
        url: s.url,
        headers: s.auth_token ? { Authorization: `Bearer ${s.auth_token}` } : {},
        optional: s.optional === true,
        primary: i === 0,
    }));
}
