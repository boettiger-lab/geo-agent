/**
 * ToolRegistry - Unified tool registry and dispatch
 * 
 * Single source of truth for ALL tools the LLM can use.
 * Registers tools from two sources:
 *   - "local" tools (map control, dataset catalog) — executed in-browser
 *   - "remote" tools (MCP server) — executed via MCPClient
 * 
 * Provides:
 *   - getToolsForLLM() → unified tools[] array in OpenAI function-calling format
 *   - executeTool(name, args) → dispatch to correct handler
 *   - isLocalTool(name) → for auto-approve logic
 */

// Idempotent read tools whose result is a pure function of their args for the
// life of a session. Memoizing these (#281) skips duplicate round-trips *and*
// keeps repeated calls from re-growing the message suffix with byte-identical
// result blocks — which is exactly the non-cacheable tail that dominates
// prefill cost (#273). Deliberately excludes `query`: SQL results are large,
// arg-varied, and have different invalidation semantics.
const DEFAULT_MEMO_TOOLS = ['get_stac_details', 'get_collection', 'browse_stac_catalog', 'get_schema'];

/**
 * Stable JSON key so `{a:1, b:2}` and `{b:2, a:1}` produce the same memo key.
 * Recurses objects/arrays; scalars fall through to JSON.stringify.
 */
function canonicalize(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
    return '{' + Object.keys(value).sort()
        .map(k => JSON.stringify(k) + ':' + canonicalize(value[k]))
        .join(',') + '}';
}

/**
 * A local tool can succeed at the transport level (returns a string) while
 * reporting failure *inside* that string as `{"success": false, ...}` — e.g.
 * get_schema on an unknown dataset or an MCP outage. Don't memoize those, or a
 * transient failure poisons the session. Cheap prefix check before parsing.
 */
function reportsFailure(resultStr) {
    if (typeof resultStr !== 'string' || !resultStr.trimStart().startsWith('{')) return false;
    try {
        return JSON.parse(resultStr)?.success === false;
    } catch {
        return false;
    }
}

export class ToolRegistry {
    /**
     * @param {Object} [options]
     * @param {string[]} [options.memoTools] - Override the idempotent-read
     *   whitelist. Pass `[]` to disable memoization entirely.
     */
    constructor(options = {}) {
        /** @type {Map<string, ToolEntry>} */
        this.tools = new Map();
        /** Session-scoped memo cache for idempotent reads (#281). */
        this.memoCache = new Map();
        this.memoWhitelist = new Set(options.memoTools ?? DEFAULT_MEMO_TOOLS);
    }

    /**
     * Register a local tool (executed in-browser).
     * 
     * @param {Object} tool
     * @param {string} tool.name - Unique tool name
     * @param {string} tool.description - Description for the LLM
     * @param {Object} tool.inputSchema - JSON Schema for parameters
     * @param {Function} tool.execute - (args) => string | Object
     */
    registerLocal(tool) {
        if (this.tools.has(tool.name)) {
            console.warn(`[Tools] Overwriting tool: ${tool.name}`);
        }
        this.tools.set(tool.name, {
            ...tool,
            source: 'local',
        });
    }

    /**
     * Register remote MCP tools.
     *
     * @param {Array} mcpTools - Tool definitions from MCPClient.getTools()
     * @param {MCPClient} mcpClient - Client instance for execution
     * @param {Function} [argsRewriter] - Optional (toolName, args) => args hook
     *   applied before forwarding to MCP. Used to inject cached STAC content
     *   inline for in-app calls (skips an upstream fetch).
     */
    registerRemote(mcpTools, mcpClient, argsRewriter = null) {
        for (const tool of mcpTools) {
            this.tools.set(tool.name, {
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema || {
                    type: 'object',
                    properties: { sql_query: { type: 'string', description: 'SQL query' } },
                    required: ['sql_query']
                },
                source: 'remote',
                mcpClient,
                argsRewriter,
            });
        }
        console.log(`[Tools] Registered ${mcpTools.length} remote tools`);
    }

    /**
     * Drop every remote tool from the registry. Use before re-registering
     * after a reconnect to avoid leaving stale entries when the server's
     * tool list has changed.
     */
    clearRemote() {
        for (const [name, tool] of this.tools) {
            if (tool.source === 'remote') this.tools.delete(name);
        }
    }

    /**
     * Get all tools formatted for the OpenAI Chat Completions API.
     * @returns {Array} tools[] array
     */
    getToolsForLLM() {
        return [...this.tools.values()].map(tool => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description,
                parameters: this.cleanSchema(tool.inputSchema),
            }
        }));
    }

    /**
     * Clean a JSON Schema to ensure compatibility with strict OpenAI tool schemas.
     * Some providers reject `anyOf`, extra keys, etc.
     */
    cleanSchema(schema) {
        if (!schema) return { type: 'object', properties: {}, required: [] };

        // Deep clone to avoid mutating originals
        const clean = JSON.parse(JSON.stringify(schema));

        // Ensure required fields exist
        if (!clean.type) clean.type = 'object';
        if (!clean.properties) clean.properties = {};

        // Replace `anyOf` with a simpler union (some models choke on anyOf)
        for (const [key, prop] of Object.entries(clean.properties || {})) {
            if (prop.anyOf) {
                // Pick the first concrete type, or fall back to object
                const first = prop.anyOf.find(a => a.type && a.type !== 'null') || { type: 'object' };
                clean.properties[key] = {
                    ...first,
                    description: prop.description || first.description || '',
                };
            }
        }

        return clean;
    }

    /**
     * Check if a tool is local (for auto-approve logic).
     */
    isLocal(name) {
        const tool = this.tools.get(name);
        return tool?.source === 'local';
    }

    /**
     * Execute a tool by name.
     * 
     * @param {string} name - Tool name
     * @param {Object} args - Tool arguments
     * @returns {Promise<ToolResult>}
     */
    async execute(name, args) {
        const tool = this.tools.get(name);
        if (!tool) {
            return {
                success: false,
                name,
                result: `Unknown tool: ${name}. Available tools: ${this.getNames().join(', ')}`,
                source: 'error',
            };
        }

        // Memoize idempotent reads on (name, canonical args) so a model that
        // re-issues the same metadata call gets a byte-identical result with no
        // MCP round-trip (#281). Keyed on the model-facing args (pre-rewriter),
        // so the argsRewriter's inline-STAC injection is skipped on a hit too.
        const memoKey = this.memoWhitelist.has(name)
            ? `${name}:${canonicalize(args ?? {})}`
            : null;
        if (memoKey && this.memoCache.has(memoKey)) {
            return { ...this.memoCache.get(memoKey), cached: true };
        }

        let result;
        try {
            if (tool.source === 'local') {
                const raw = await tool.execute(args);
                result = {
                    success: true,
                    name,
                    result: typeof raw === 'string' ? raw : JSON.stringify(raw),
                    source: 'local',
                };
            } else {
                // Remote MCP tool
                const finalArgs = tool.argsRewriter ? tool.argsRewriter(tool.name, args) : args;
                const raw = await tool.mcpClient.callTool(tool.name, finalArgs);
                result = {
                    success: true,
                    name,
                    result: raw,
                    source: 'remote',
                    sqlQuery: args.sql_query || args.query || null,
                };
            }
        } catch (error) {
            console.error(`[Tools] Error executing ${name}:`, error);
            return {
                success: false,
                name,
                result: `Error executing ${name}: ${error.message}`,
                source: 'error',
            };
        }

        // Only cache genuine successes — never a result that reports failure
        // inside its own payload, so a transient outage doesn't stick.
        if (memoKey && result.success && !reportsFailure(result.result)) {
            this.memoCache.set(memoKey, result);
        }
        return result;
    }

    /**
     * Drop the idempotent-read memo cache. Called on conversation reset so a
     * fresh session re-fetches metadata rather than serving a prior session's.
     */
    clearMemo() {
        this.memoCache.clear();
    }

    /**
     * Execute multiple tools in sequence.
     * @param {Array<{name: string, args: Object}>} calls
     * @returns {Promise<Array<ToolResult>>}
     */
    async executeAll(calls) {
        const results = [];
        for (const { name, args } of calls) {
            results.push(await this.execute(name, args));
        }
        return results;
    }

    /**
     * Get all registered tool names.
     */
    getNames() {
        return [...this.tools.keys()];
    }

    /**
     * Check if a tool exists.
     */
    has(name) {
        return this.tools.has(name);
    }
}
