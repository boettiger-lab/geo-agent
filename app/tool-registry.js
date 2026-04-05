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

export class ToolRegistry {
    constructor() {
        /** @type {Map<string, ToolEntry>} */
        this.tools = new Map();
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
     */
    registerRemote(mcpTools, mcpClient) {
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
            });
        }
        console.log(`[Tools] Registered ${mcpTools.length} remote tools`);
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

        try {
            if (tool.source === 'local') {
                const result = await tool.execute(args);
                return {
                    success: true,
                    name,
                    result: typeof result === 'string' ? result : JSON.stringify(result),
                    source: 'local',
                };
            } else {
                // Remote MCP tool
                const result = await tool.mcpClient.callTool(tool.name, args);
                return {
                    success: true,
                    name,
                    result,
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
