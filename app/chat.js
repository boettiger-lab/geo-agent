// Biodiversity Data Chatbot
// Uses an OpenAI-compatible LLM with MCP server access for querying biodiversity data
//
// Debugging & Error Handling:
// - Enhanced logging for MCP query results and empty responses
// - Detects and warns about potential truncation (50K character limit in mcp-server-motherduck)
// - Validates tool call arguments and LLM responses for empty content
// - Provides user-friendly error messages for common failure scenarios

// Import MCP SDK for proper SSE communication
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Import generic map control modules
import { layerRegistry } from './layer-registry.js';
import { generateTools } from './mcp-tools.js';

class BiodiversityChatbot {
    constructor(config) {
        this.config = config;
        this.mcpServerUrl = config.mcp_server_url;
        this.systemPrompt = null;
        this.messages = [];
        this.mcpClient = null;
        this.mcpTools = [];
        this.selectedModel = config.llm_model || 'kimi'; // Default model
        this.currentTurnQueries = []; // Track ALL SQL queries in current turn
        this.mcpConnected = false; // Track connection state
        this.reconnectAttempts = 0; // Track reconnection attempts
        this.maxReconnectAttempts = 3; // Maximum reconnection attempts
        this.healthCheckInterval = null; // For periodic health checks

        // Initialize layer registry and tools (will be loaded after map is ready)
        this.localTools = [];

        this.initializeUI();
        this.loadSystemPrompt();
        this.loadLayersAndInitTools();
        this.initMCP();
        this.startHealthCheck(); // Start monitoring connection health
    }

    // Load layer configuration and initialize tool factory
    async loadLayersAndInitTools() {
        try {
            // Load layer configuration from JSON
            await layerRegistry.loadFromJson('layers-config.json');
            console.log('✓ Layer registry loaded:', layerRegistry.getSummary());

            // Wait for MapController to be available (set up in map.js)
            const waitForMapController = () => {
                return new Promise((resolve) => {
                    const checkInterval = setInterval(() => {
                        if (window.MapController) {
                            clearInterval(checkInterval);
                            resolve();
                        }
                    }, 100);
                });
            };

            await waitForMapController();

            // Generate tools dynamically from layer metadata
            this.localTools = generateTools(layerRegistry, window.MapController);
            console.log('✓ Generated', this.localTools.length, 'map control tools:',
                this.localTools.map(t => t.name).join(', '));
        } catch (error) {
            console.error('Failed to load layer configuration:', error);
            // Fall back to empty tools
            this.localTools = [];
        }
    }



    // Check if a tool is a local tool (executed in browser)
    isLocalTool(toolName) {
        return this.localTools.some(tool => tool.name === toolName);
    }

    // Execute a local tool
    executeLocalTool(toolName, args) {
        const tool = this.localTools.find(t => t.name === toolName);
        if (!tool) {
            return JSON.stringify({ success: false, error: `Unknown local tool: ${toolName}` });
        }
        console.log(`[Local Tool] Executing ${toolName} with args:`, args);
        const result = tool.execute(args);
        console.log(`[Local Tool] Result:`, result);
        return result;
    }

    getCurrentModelConfig() {
        // Find the config for the currently selected model
        const modelConfig = this.config.llm_models?.find(m => m.value === this.selectedModel);
        if (!modelConfig) {
            console.warn(`Model config not found for ${this.selectedModel}, using first model`);
            return this.config.llm_models?.[0] || {
                value: 'kimi',
                label: 'Kimi',
                endpoint: 'https://llm-proxy.nrp-nautilus.io/v1',
                api_key: 'EMPTY'
            };
        }
        return modelConfig;
    }

    async loadSystemPrompt() {
        try {
            const response = await fetch('system-prompt.md');
            this.systemPrompt = await response.text();
            console.log('✓ System prompt loaded');
        } catch (error) {
            console.error('Failed to load system prompt:', error);
            this.systemPrompt = 'You are a helpful assistant for biodiversity data analysis.';
        }
    }

    async initMCP() {
        try {
            console.log('🔌 Initializing MCP connection...');

            // Create Streamable HTTP transport
            const transport = new StreamableHTTPClientTransport(new URL(this.mcpServerUrl));

            // Create MCP client
            this.mcpClient = new Client({
                name: 'biodiversity-chatbot',
                version: '1.0.0'
            }, {
                capabilities: {}
            });

            // Connect to MCP server
            await this.mcpClient.connect(transport);
            console.log('✓ MCP client connected');
            this.mcpConnected = true;
            this.reconnectAttempts = 0; // Reset on successful connection

            // Get available tools
            const toolsResponse = await this.mcpClient.listTools();
            this.mcpTools = toolsResponse.tools;
            console.log('✓ Available MCP tools:', this.mcpTools.map(t => t.name));

        } catch (error) {
            console.error('❌ MCP initialization error:', error);
            this.mcpClient = null;
            this.mcpConnected = false;
            this.mcpTools = []; // Ensure tools is an empty array, not undefined
            // Show error in chat UI
            setTimeout(() => {
                this.addMessage('error', 'Database connection failed. Attempting to reconnect...');
            }, 1000);
        }
    }

    async reconnectMCP() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('❌ Max reconnection attempts reached');
            throw new Error('Could not reconnect to database. Please refresh the page.');
        }

        this.reconnectAttempts++;
        console.log(`🔄 Reconnecting to MCP (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);

        // Show reconnection message to user
        this.addMessage('reconnecting', `🔄 Reconnecting to database (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);

        // Close existing client if present
        if (this.mcpClient) {
            try {
                await this.mcpClient.close();
            } catch (e) {
                console.warn('Error closing old client:', e);
            }
        }

        // Wait before reconnecting (exponential backoff)
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 5000);
        await new Promise(resolve => setTimeout(resolve, delay));

        await this.initMCP();

        if (!this.mcpConnected) {
            throw new Error('Reconnection failed');
        }

        // Show success message
        this.addMessage('reconnecting', '✓ Database connection restored!');
    }

    startHealthCheck() {
        // Check connection health every 5 minutes
        this.healthCheckInterval = setInterval(async () => {
            if (this.mcpConnected && this.mcpClient) {
                try {
                    console.log('🏥 Performing health check...');
                    // Try to list tools as a lightweight check
                    await this.mcpClient.listTools();
                    console.log('✓ Health check passed');
                } catch (error) {
                    console.warn('❌ Health check failed:', error.message);
                    this.mcpConnected = false;
                    // Don't show error to user yet - will reconnect on next query
                }
            }
        }, 5 * 60 * 1000); // 5 minutes
    }

    stopHealthCheck() {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }
    }

    initializeUI() {
        // Configure marked to use highlight.js
        if (window.marked && window.hljs) {
            marked.setOptions({
                highlight: function (code, lang) {
                    const language = hljs.getLanguage(lang) ? lang : 'plaintext';
                    return hljs.highlight(code, { language }).value;
                },
                langPrefix: 'hljs language-'
            });
        }

        // Chat container
        const container = document.createElement('div');
        container.id = 'chat-container';

        // Build model selector options from config
        const modelOptions = this.config.llm_models?.map(model =>
            `<option value="${model.value}">${model.label}</option>`
        ).join('') || '<option value="kimi">Kimi</option>';

        container.innerHTML = `
            <div id="chat-header">
                <h3>🌍 Biodiversity Data Assistant</h3>
                <button id="chat-toggle">−</button>
            </div>
            <div id="chat-messages"></div>
            <div id="chat-input-container">
                <input type="text" id="chat-input" placeholder="Ask about biodiversity data..." />
                <button id="chat-send">Send</button>
            </div>
            <div id="chat-footer">
                <select id="model-selector" title="Select LLM Model">
                    ${modelOptions}
                </select>
            </div>
        `;
        document.body.appendChild(container);

        // Set initial model value
        document.getElementById('model-selector').value = this.selectedModel;

        // Event listeners
        document.getElementById('chat-toggle').addEventListener('click', () => this.toggleChat());
        document.getElementById('chat-send').addEventListener('click', () => this.sendMessage());
        document.getElementById('chat-input').addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) this.sendMessage();
        });
        document.getElementById('model-selector').addEventListener('change', (e) => {
            this.selectedModel = e.target.value;
            console.log('Model changed to:', this.selectedModel);
        });

        // Welcome message
        this.addMessage(
            'assistant',
            'Hi! I can help you explore global biodiversity data and control the map. Try asking:\n\n' +
            '* "Which protected areas have the highest ave number of threatened species in the US? Also show them on the map"\n' +
            '* "What fraction of Canada is in protected areas? What fraction of the vulnerable carbon is protected?"\n' +
            '* "Describe the datasets you have available and where I can learn more about them"\n' +
            '* "Compute total carbon storage & species richness of each protected area in Brazil as a csv file"'
        );
    }

    toggleChat() {
        const container = document.getElementById('chat-container');
        const toggle = document.getElementById('chat-toggle');
        container.classList.toggle('collapsed');
        toggle.textContent = container.classList.contains('collapsed') ? '+' : '−';
    }

    addMessage(role, content, metadata = {}) {
        const messagesDiv = document.getElementById('chat-messages');
        const messageDiv = document.createElement('div');
        messageDiv.className = `chat-message ${role}`;

        // Debug logging
        console.log('[UI] Adding message, role:', role, 'has SQL queries:', metadata.sqlQueries?.length || 0);

        // Use marked.js for markdown rendering
        // Handle undefined/null/empty content
        const safeContent = content || '';
        const formatted = marked.parse(safeContent);
        messageDiv.innerHTML = formatted;

        messagesDiv.appendChild(messageDiv);

        // Add SQL query details if present - now handles multiple queries
        if (metadata.sqlQueries && metadata.sqlQueries.length > 0) {
            console.log(`[UI] ✅ Appending ${metadata.sqlQueries.length} SQL query details element(s)`);

            metadata.sqlQueries.forEach((sqlQuery, index) => {
                const detailsDiv = document.createElement('details');
                detailsDiv.style.marginTop = '10px';
                detailsDiv.style.fontSize = '12px';
                detailsDiv.style.opacity = '0.8';

                const summaryDiv = document.createElement('summary');
                const queryLabel = metadata.sqlQueries.length > 1 ? `Query ${index + 1}` : 'View SQL Query';
                summaryDiv.textContent = queryLabel;
                summaryDiv.className = 'query-summary-btn';
                summaryDiv.style.cursor = 'pointer';
                summaryDiv.style.userSelect = 'none';

                const codeDiv = document.createElement('pre');
                codeDiv.style.marginTop = '8px';
                codeDiv.style.padding = '0';
                codeDiv.style.borderRadius = '4px';
                codeDiv.style.overflowX = 'auto';

                const codeElement = document.createElement('code');
                codeElement.className = 'language-sql';
                codeElement.textContent = sqlQuery;
                codeDiv.appendChild(codeElement);

                // Apply syntax highlighting if available
                if (window.hljs) {
                    window.hljs.highlightElement(codeElement);
                }

                detailsDiv.appendChild(summaryDiv);
                detailsDiv.appendChild(codeDiv);
                messagesDiv.appendChild(detailsDiv);
            });
        } else if (role === 'assistant') {
            console.log('[UI] No SQL queries in metadata - this is expected for clarifications/follow-ups without prior queries');
        }
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }

    // Show a tool call proposal and wait for user approval
    async showToolCallProposal(toolCalls, iterationNumber, reasoning) {
        return new Promise((resolve) => {
            const messagesDiv = document.getElementById('chat-messages');

            const proposalDiv = document.createElement('div');
            proposalDiv.className = 'chat-message tool-proposal';

            let content = '';

            // Add reasoning if present
            if (reasoning && reasoning.trim()) {
                content += `<div class="tool-reasoning" style="margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px solid rgba(0,0,0,0.1);">${marked.parse(reasoning)}</div>`;
            }

            // Check if all tool calls are local (map control) tools
            const allLocalTools = toolCalls.every(tc => this.isLocalTool(tc.function.name));

            toolCalls.forEach((toolCall, index) => {
                const functionArgs = JSON.parse(toolCall.function.arguments);
                const isLocal = this.isLocalTool(toolCall.function.name);

                if (isLocal) {
                    // Format local tool call (map control)
                    const argsDisplay = JSON.stringify(functionArgs, null, 2);
                    content += `
                        <div class="tool-call-item">
                            <details>
                                <summary class="query-summary-btn" style="cursor: pointer; user-select: none;">🗺️ ${toolCall.function.name}</summary>
                                <pre style="margin-top: 8px; padding: 8px; background: rgba(0,0,0,0.05); border-radius: 4px; overflow-x: auto;"><code class="language-json">${this.escapeHtml(argsDisplay)}</code></pre>
                            </details>
                        </div>
                    `;
                } else {
                    // Format MCP tool call (SQL query)
                    const sqlQuery = functionArgs.sql_query || functionArgs.query || 'No query provided';
                    content += `
                        <div class="tool-call-item">
                            <details>
                                <summary class="query-summary-btn" style="cursor: pointer; user-select: none;">${toolCall.function.name}</summary>
                                <pre style="margin-top: 8px; padding: 0; border-radius: 4px; overflow-x: auto;"><code class="language-sql">${this.escapeHtml(sqlQuery)}</code></pre>
                            </details>
                        </div>
                    `;
                }
            });

            // Add approval button with context-appropriate label
            const buttonLabel = allLocalTools ? '✓ Update Map' : '✓ Run Query';
            content += `
                <div class="tool-approval-buttons" style="margin-top: 12px;">
                    <button class="approve-btn" style="padding: 8px 16px; background: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: 500;">${buttonLabel}</button>
                </div>
            `;

            proposalDiv.innerHTML = content;
            messagesDiv.appendChild(proposalDiv);

            // Apply syntax highlighting
            if (window.hljs) {
                proposalDiv.querySelectorAll('code').forEach(block => {
                    window.hljs.highlightElement(block);
                });
            }

            messagesDiv.scrollTop = messagesDiv.scrollHeight;

            // Re-enable input so user can type new question to interrupt
            const input = document.getElementById('chat-input');
            const sendButton = document.getElementById('chat-send');
            input.disabled = false;
            sendButton.disabled = false;

            // Handle approval
            const approveBtn = proposalDiv.querySelector('.approve-btn');

            approveBtn.addEventListener('click', () => {
                approveBtn.disabled = true;
                approveBtn.textContent = '⏳ Running...';
                resolve({ approved: true, toolCalls });
            });
        });
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // Show tool call results
    showToolResults(results, iterationNumber) {
        const messagesDiv = document.getElementById('chat-messages');

        const resultsDiv = document.createElement('div');
        resultsDiv.className = 'chat-message tool-results';

        let content = '';

        results.forEach((result, index) => {
            content += `
                <details>
                    <summary class="query-summary-btn" style="cursor: pointer; user-select: none;">query result</summary>
                    <pre style="margin-top: 8px; background: rgba(0,0,0,0.05); padding: 8px; border-radius: 4px; overflow-x: auto; max-height: 300px;"><code>${this.escapeHtml(result.substring(0, 5000))}${result.length > 5000 ? '\n... (truncated)' : ''}</code></pre>
                </details>
            `;
        });

        resultsDiv.innerHTML = content;
        resultsDiv.id = 'latest-tool-results'; // Mark this for adding thinking indicator
        messagesDiv.appendChild(resultsDiv);
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }

    // Ask if user wants to continue with another tool call
    async askContinue(iterationNumber) {
        return new Promise((resolve) => {
            // Instead of a separate message, show the processing message inside the most recent query result section
            const resultsDiv = document.querySelector('.tool-results details:last-of-type');
            if (resultsDiv) {
                // Insert a processing message at the end of the result section
                const processingP = document.createElement('p');
                processingP.style.fontSize = '14px';
                processingP.style.opacity = '0.8';
                processingP.textContent = 'processing results...';
                processingP.className = 'processing-inline';
                resultsDiv.appendChild(processingP);
                // Remove after short delay
                setTimeout(() => {
                    processingP.remove();
                    resolve(true);
                }, 500);
            } else {
                // Fallback: if no result section, just resolve after delay
                setTimeout(() => resolve(true), 500);
            }
        });
    }

    // Show thinking indicator immediately
    showThinking() {
        const messagesDiv = document.getElementById('chat-messages');

        // Check if we should add thinking indicator inside the latest tool results (more compact)
        const latestToolResults = document.getElementById('latest-tool-results');
        if (latestToolResults) {
            // Add thinking indicator inside the tool results box
            const thinkingDiv = document.createElement('div');
            thinkingDiv.id = 'thinking-indicator';
            thinkingDiv.className = 'thinking-inline';
            thinkingDiv.innerHTML = '💭 Thinking...';
            latestToolResults.appendChild(thinkingDiv);
            latestToolResults.removeAttribute('id'); // Remove marker so next call doesn't reuse
        } else {
            // No tool results yet, create separate box (initial query)
            const thinkingDiv = document.createElement('div');
            thinkingDiv.id = 'thinking-indicator';
            thinkingDiv.className = 'chat-message system';
            thinkingDiv.innerHTML = '💭 Thinking...';
            messagesDiv.appendChild(thinkingDiv);
        }

        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }

    // Remove thinking indicator
    clearThinking() {
        const thinkingDiv = document.getElementById('thinking-indicator');
        if (thinkingDiv) {
            thinkingDiv.remove();
        }
    }

    // Remove progress container
    clearProgressMessages() {
        const progressContainer = document.getElementById('progress-container');
        if (progressContainer) {
            progressContainer.remove();
        }
    }

    // Generate a human-readable description of what a SQL query does
    describeQuery(sqlQuery) {
        const lower = sqlQuery.toLowerCase();

        // Data export to CSV
        if (lower.includes('.csv') && lower.includes('copy')) {
            return 'Exporting results to CSV file';
        }

        // Count queries
        if (lower.includes('count(')) {
            if (lower.includes('species')) return 'Analyzing species data';
            if (lower.includes('wdpa')) return 'Counting protected areas';
            if (lower.includes('peatland') || (lower.includes('z between') && lower.includes('22'))) {
                return 'Calculating total peatland area';
            }
            if (lower.includes('protected')) return 'Counting protected areas';
            return 'Counting matching records';
        }

        // Sum/aggregate queries
        if (lower.includes('sum(') && lower.includes('carbon')) {
            return 'Calculating total carbon storage';
        }

        // Average queries
        if (lower.includes('avg(') && lower.includes('ncp')) {
            return 'Calculating average biodiversity importance';
        }

        // Geographic filters
        let desc = 'Querying ';
        if (lower.includes('protected')) desc += 'protected areas';
        else if (lower.includes('wdpa')) desc += 'WDPA sites';
        else if (lower.includes('area')) desc += 'areas';
        else desc += 'data';

        // Add geographic context
        if (lower.includes("country = 'us'") || lower.includes("iso3 = 'usa'")) {
            desc += ' in the United States';
        } else if (lower.includes("country = 'br'")) {
            desc += ' in Brazil';
        } else if (lower.includes("country = 'in'")) {
            desc += ' in India';
        } else if (lower.includes("country = 'au'")) {
            desc += ' in Australia';
        } else if (lower.includes('country =')) {
            desc += ' by country';
        }

        return desc;
    }

    async sendMessage() {
        const input = document.getElementById('chat-input');
        const sendButton = document.getElementById('chat-send');
        const userMessage = input.value.trim();

        if (!userMessage) return;

        console.log('[Chat] Sending message:', userMessage);

        // Add user message
        this.addMessage('user', userMessage);
        this.messages.push({ role: 'user', content: userMessage });

        // Clear input and disable
        input.value = '';
        input.disabled = true;
        sendButton.disabled = true;

        // Clear any previous progress messages from last turn
        this.clearProgressMessages();

        // Show immediate thinking indicator while LLM generates response
        this.showThinking();

        try {
            console.log('[Chat] Calling queryLLM...');
            const result = await this.queryLLM(userMessage);
            console.log('[Chat] Got response:', result);

            // Clear thinking indicator
            this.clearThinking();

            // Check if cancelled
            if (result.cancelled) {
                console.log('[Chat] User cancelled tool execution');
                return;
            }

            // Add assistant response (handle undefined/null)
            if (result.response) {
                const finalResponse = result.response;

                // Debug logging for SQL queries
                if (result.sqlQueries && result.sqlQueries.length > 0) {
                    console.log(`[Chat] ✅ ${result.sqlQueries.length} SQL queries executed`);
                    result.sqlQueries.forEach((q, i) => console.log(`[Chat]   Query ${i + 1}: ${q.substring(0, 100)}...`));
                }

                // Show final interpretation message
                this.addMessage('assistant', finalResponse);
                this.messages.push({ role: 'assistant', content: finalResponse });
            } else {
                this.addMessage('error', "I received an empty response. Please try again.");
            }

        } catch (error) {
            console.error('[Chat] Error caught:', error);
            console.error('[Chat] Error stack:', error.stack);

            this.addMessage('error', `Error: ${error.message}`);
        } finally {
            input.disabled = false;
            sendButton.disabled = false;
            input.focus();
        }
    }

    async queryLLM(userMessage) {
        if (!this.mcpClient) {
            return { response: "Sorry, the database connection is not available. Please refresh the page to try again." };
        }

        // Get current model configuration
        const modelConfig = this.getCurrentModelConfig();

        // Check if model explicitly requests Responses API
        const useResponsesAPI = modelConfig.use_responses_api === true;

        // Build full endpoint URL
        let endpoint = modelConfig.endpoint;
        if (useResponsesAPI) {
            // Model explicitly configured to use Responses API
            if (!endpoint.endsWith('/responses')) {
                endpoint = endpoint.replace(/\/$/, '') + '/responses';
            }
        } else {
            // Default: use Chat Completions API
            if (!endpoint.endsWith('/chat/completions')) {
                endpoint = endpoint.replace(/\/$/, '') + '/chat/completions';
            }
        }
        console.log('[LLM] Starting request to:', endpoint);
        console.log('[LLM] Using model config:', { model: modelConfig.value, endpoint: modelConfig.endpoint });
        console.log('[LLM] Origin:', window.location.origin);

        // Track ALL SQL queries executed in this turn
        this.currentTurnQueries = [];

        // Build the prompt with system context
        // We will maintain this conversation history for the duration of this turn
        let currentTurnMessages = [
            {
                role: 'system',
                content: this.systemPrompt
            },
            ...this.messages.slice(-10), // Keep last 10 messages for context
            {
                role: 'user',
                content: userMessage
            }
        ];

        // Convert MCP tools to OpenAI function format
        console.log('[LLM] Raw MCP tools available:', this.mcpTools?.length || 0);
        console.log('[LLM] Local tools available:', this.localTools?.length || 0);

        // Check if MCP tools are available (local tools are always available)
        if (!this.mcpTools || this.mcpTools.length === 0) {
            console.warn('[LLM] ⚠️ No MCP tools available - database queries will not work');
            // Continue anyway since we have local tools for map control
        }

        // Convert MCP tools to OpenAI function format
        const mcpToolsFormatted = (this.mcpTools || []).map(tool => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema || {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description: 'SQL query to execute'
                        }
                    },
                    required: ['query']
                }
            }
        }));

        // Convert local tools to OpenAI function format
        const localToolsFormatted = this.localTools.map(tool => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema
            }
        }));

        // Combine all tools
        const tools = [...mcpToolsFormatted, ...localToolsFormatted];

        console.log('[LLM] Converted tools:', JSON.stringify(tools, null, 2));

        let toolCallCount = 0;
        const MAX_TOOL_CALLS = 8; // Guardrail: Allow up to 8 tool calls per user message

        while (toolCallCount < MAX_TOOL_CALLS) {
            // Build request payload - conditional format based on model
            let requestPayload;
            if (useResponsesAPI) {
                // Responses API format
                // Convert messages to a single input string
                const inputText = currentTurnMessages.map(msg => {
                    if (msg.role === 'system') return `System: ${msg.content}`;
                    if (msg.role === 'user') return `User: ${msg.content}`;
                    if (msg.role === 'assistant') return `Assistant: ${msg.content}`;
                    if (msg.role === 'tool') return `Tool Result: ${msg.content}`;
                    return '';
                }).filter(Boolean).join('\n\n');

                requestPayload = {
                    model: this.selectedModel,
                    input: inputText,
                    tools: tools,
                    tool_choice: 'auto'
                };
            } else {
                // Chat Completions API format for other models
                requestPayload = {
                    model: this.selectedModel,
                    messages: currentTurnMessages,
                    tools: tools,
                    tool_choice: 'auto'
                };
            }

            console.log(`[LLM] Request payload (Step ${toolCallCount + 1}):`, {
                model: requestPayload.model,
                messageCount: requestPayload.messages?.length || 'N/A (using input string)',
                toolCount: requestPayload.tools.length
            });

            // Call the LLM proxy
            console.log('[LLM] Sending fetch request...');
            const startTime = Date.now();

            // Prepare headers with proxy authentication
            const headers = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${modelConfig.api_key}`
            };

            console.log('[LLM] Using API key from model config');

            // Set up 5-minute timeout for LLM requests
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 300000); // 5 minutes

            try {
                var response = await fetch(endpoint, {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify(requestPayload),
                    signal: controller.signal
                });
            } catch (error) {
                if (error.name === 'AbortError') {
                    throw new Error('Request timed out after 5 minutes');
                }
                throw error;
            } finally {
                clearTimeout(timeoutId);
            }

            const elapsed = Date.now() - startTime;
            console.log(`[LLM] Response received after ${elapsed}ms, status: ${response.status}`);

            if (!response.ok) {
                const errorText = await response.text();
                console.error('[LLM] Error response body:', errorText);
                throw new Error(`LLM API error (${response.status}): ${response.statusText}`);
            }

            const data = await response.json();
            let message;

            if (useResponsesAPI) {
                // Parse Responses API format
                // Responses API returns output array with text and function_call items
                const output = data.output || [];

                // Extract text content
                const textItems = output.filter(item => item.type === 'text');
                const content = textItems.map(item => item.text).join('');

                // Extract function calls
                const functionCallItems = output.filter(item => item.type === 'function_call');
                const toolCalls = functionCallItems.map(item => ({
                    id: item.id || `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    type: 'function',
                    function: {
                        name: item.name,
                        arguments: JSON.stringify(item.arguments)
                    }
                }));

                message = {
                    role: 'assistant',
                    content: content || null,
                    tool_calls: toolCalls.length > 0 ? toolCalls : undefined
                };
            } else {
                // Parse Chat Completions API format
                message = data.choices[0].message;
            }

            // Add the assistant's response to the conversation history
            currentTurnMessages.push(message);

            // Check if LLM wants to call a tool
            if (message.tool_calls && message.tool_calls.length > 0) {
                toolCallCount++;
                console.log(`[LLM] Tool calls requested (${toolCallCount}/${MAX_TOOL_CALLS}):`, message.tool_calls.length);

                // Clear thinking indicator
                this.clearThinking();

                // Show tool call proposal and wait for approval
                // Pass message.content (reasoning) to be displayed inside the proposal
                const approval = await this.showToolCallProposal(message.tool_calls, toolCallCount, message.content);

                if (!approval.approved) {
                    console.log('[User] Tool call rejected by user');
                    this.addMessage('system', 'Tool call cancelled. You can ask a different question or modify your request.');
                    return {
                        response: null,
                        sqlQueries: this.currentTurnQueries,
                        cancelled: true
                    };
                }

                // User approved - execute all tool calls
                const toolResults = [];

                for (const toolCall of message.tool_calls) {
                    console.log('[LLM] Executing tool:', toolCall.function.name);
                    console.log('[LLM] Tool arguments:', toolCall.function.arguments);
                    console.log('[LLM] Tool call ID:', toolCall.id);

                    let functionArgs;
                    try {
                        functionArgs = JSON.parse(toolCall.function.arguments);
                    } catch (e) {
                        console.error('[LLM] Failed to parse tool arguments:', e);
                        const errorMsg = "Error: Failed to parse tool arguments. Please ensure arguments are valid JSON.";
                        currentTurnMessages.push({
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            content: errorMsg
                        });
                        toolResults.push(errorMsg);
                        continue;
                    }

                    // Check if this is a local tool (map control) or MCP tool (database query)
                    const toolName = toolCall.function.name;

                    if (this.isLocalTool(toolName)) {
                        // Execute local tool (no MCP needed)
                        console.log(`[Local Tool] Executing ${toolName}...`);
                        let toolResult;
                        try {
                            toolResult = this.executeLocalTool(toolName, functionArgs);
                            console.log(`[Local Tool] ✅ ${toolName} completed`);
                            toolResults.push(toolResult);
                        } catch (err) {
                            console.error('[Local Tool] Execution error:', err);
                            toolResult = JSON.stringify({ success: false, error: err.message });
                            toolResults.push(toolResult);
                        }

                        // Add tool result to messages
                        currentTurnMessages.push({
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            content: toolResult
                        });
                    } else {
                        // This is an MCP tool (database query)
                        // Capture the SQL query
                        const sqlQuery = functionArgs.sql_query || functionArgs.query;

                        if (sqlQuery) {
                            this.currentTurnQueries.push(sqlQuery);
                            console.log(`[SQL] ✅ SQL query ${this.currentTurnQueries.length} captured`);
                        }

                        // Check if the query argument is missing or empty
                        if (!sqlQuery || sqlQuery.trim() === '') {
                            console.warn('[LLM] ⚠️  WARNING: Tool call missing or empty "query" argument!');
                            const errorMsg = "Error: The 'query' argument was missing or empty. Please provide a valid SQL query.";
                            currentTurnMessages.push({
                                role: 'tool',
                                tool_call_id: toolCall.id,
                                content: errorMsg
                            });
                            toolResults.push(errorMsg);
                            continue;
                        }

                        // Execute the query via MCP
                        console.log('[MCP] Executing query via MCP...');
                        let queryResult;
                        try {
                            queryResult = await this.executeMCPQuery(sqlQuery);
                            console.log(`[SQL] ✅ Query ${this.currentTurnQueries.length} completed`);
                            toolResults.push(queryResult);
                        } catch (err) {
                            console.error('[MCP] Execution error:', err);
                            queryResult = `Error executing query: ${err.message}`;
                            toolResults.push(queryResult);
                        }

                        // Add tool result to messages
                        currentTurnMessages.push({
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            content: queryResult
                        });
                    }
                }

                // Remove the running button now that query is complete
                const proposalDivs = document.querySelectorAll('.tool-proposal');
                if (proposalDivs.length > 0) {
                    const latestProposal = proposalDivs[proposalDivs.length - 1];
                    const approvalButtonsDiv = latestProposal.querySelector('.tool-approval-buttons');
                    if (approvalButtonsDiv) {
                        approvalButtonsDiv.remove();
                        console.log('[UI] Removed running button');
                    } else {
                        console.log('[UI] No approval buttons div found');
                    }
                } else {
                    console.log('[UI] No proposal div found');
                }

                // Show results to user
                this.showToolResults(toolResults, toolCallCount);

                // Show thinking indicator while LLM analyzes the results
                this.showThinking();

                // Ask if should continue
                await this.askContinue(toolCallCount);

                // Loop continues to next iteration to send tool results back to LLM
            } else {
                // No tool calls, this is the final response
                console.log('[LLM] Returning direct message content (no tool calls)');
                const directContent = message.content;

                // Check for empty direct response
                if (!directContent || directContent.trim() === '') {
                    console.warn('[LLM] ⚠️  WARNING: LLM returned empty direct content');
                    return {
                        response: 'I received your question but had trouble generating a response. Please try rephrasing or asking something else.',
                        sqlQueries: this.currentTurnQueries
                    };
                }

                // Check for SQL as text (fallback check)
                if (directContent.toLowerCase().includes('select ') &&
                    directContent.toLowerCase().includes('from ') &&
                    this.currentTurnQueries.length === 0) {
                    console.warn('[LLM] ⚠️  WARNING: LLM appears to be returning SQL as text instead of using tool call!');
                }

                return {
                    response: directContent,
                    sqlQueries: this.currentTurnQueries
                };
            }
        }

        // If we exit the loop, we hit the max tool calls limit
        console.warn(`[LLM] ⚠️  Hit maximum tool call limit (${MAX_TOOL_CALLS})`);
        return {
            response: `I've reached the maximum number of steps (${MAX_TOOL_CALLS}) allowed to answer your question without finding a final answer. I may be getting stuck in a loop. Please try to be more specific or ask a simpler question.`,
            sqlQueries: this.currentTurnQueries
        };
    }

    async executeMCPQuery(sqlQuery, retryCount = 0) {
        const maxRetries = 2;

        // For stateless HTTP servers, reinitialize connection before each query
        // This ensures a fresh session since the server doesn't maintain state
        console.log('🔄 Reinitializing MCP client for stateless HTTP...');
        try {
            await this.initMCP();
        } catch (initError) {
            console.error('❌ Failed to initialize MCP client:', initError);
            throw new Error('Database connection unavailable. Please refresh the page.');
        }

        if (!this.mcpClient || !this.mcpConnected) {
            throw new Error('Database connection unavailable. Please refresh the page.');
        }

        console.log('🔧 Executing MCP query:', sqlQuery.substring(0, 100) + '...');

        try {
            // Use MCP SDK to call the tool
            const result = await this.mcpClient.callTool({
                name: 'query',
                arguments: {
                    sql_query: sqlQuery  // Match server's Python function parameter name
                }
            });

            console.log('[MCP] Raw result structure:', {
                hasContent: !!result.content,
                contentLength: result.content?.length,
                contentType: typeof result.content
            });

            // Extract text from result
            if (result.content && result.content.length > 0) {
                const text = result.content[0].text;
                const textLength = text?.length || 0;

                console.log('[MCP] Result text length:', textLength, 'characters');

                // Check for empty results
                if (!text || text.trim() === '') {
                    console.warn('[MCP] ⚠️  WARNING: Query returned empty text content');
                    console.log('[MCP] Content object:', result.content[0]);
                    console.log('[MCP] NOTE: SQL query is preserved and will be shown in UI for debugging');
                    return 'The query executed successfully but returned no data. This could mean:\n- No rows matched your query criteria\n- The result was empty\n\n**Check the SQL query below** to verify it\'s correct, or try a different query.';
                }

                // Check for potential truncation (mcp-server-motherduck has 50,000 char limit)
                if (textLength >= 49000) {
                    console.warn('[MCP] ⚠️  WARNING: Result may be truncated (approaching 50K character limit)');
                    console.warn('[MCP] Consider adding LIMIT clause to reduce result size');
                }

                console.log('✅ Query result received:', text.substring(0, 200) + '...');
                return text;
            }

            // No content in response
            console.error('[MCP] ❌ No content in MCP response');
            console.error('[MCP] Full result object:', JSON.stringify(result, null, 2));
            throw new Error('No content in MCP response');

        } catch (error) {
            console.error('❌ MCP query error:', error);
            console.error('[MCP] Error details:', {
                message: error.message,
                stack: error.stack,
                type: error.constructor.name
            });

            // Check if this looks like a connection error and we can retry
            const isConnectionError =
                error.message?.includes('connection') ||
                error.message?.includes('timeout') ||
                error.message?.includes('network') ||
                error.message?.includes('fetch') ||
                error.name === 'TypeError';

            if (isConnectionError && retryCount < maxRetries) {
                console.log(`🔄 Connection error detected, retrying (${retryCount + 1}/${maxRetries})...`);
                this.mcpConnected = false; // Mark as disconnected

                // Wait a bit before retrying
                await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));

                try {
                    await this.reconnectMCP();
                    // Retry the query
                    return await this.executeMCPQuery(sqlQuery, retryCount + 1);
                } catch (reconnectError) {
                    console.error('❌ Reconnection failed:', reconnectError);
                    throw new Error(`Database connection lost. Please refresh the page. (${error.message})`);
                }
            }

            throw new Error(`Database query failed: ${error.message}`);
        }
    }
}

// Initialize chatbot when config is loaded
let chatbot;

// Wait for DOM to be ready before initializing chatbot
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeChatbot);
} else {
    // DOM is already ready
    initializeChatbot();
}

function initializeChatbot() {
    fetch('config.json')
        .then(response => response.json())
        .then(config => {
            console.log('Config loaded successfully');
            chatbot = new BiodiversityChatbot(config);
            console.log('Biodiversity chatbot initialized');

            // Clean up on page unload
            window.addEventListener('beforeunload', () => {
                if (chatbot) {
                    chatbot.stopHealthCheck();
                    if (chatbot.mcpClient) {
                        chatbot.mcpClient.close().catch(e => console.warn('Error closing MCP client:', e));
                    }
                }
            });
        })
        .catch(error => {
            console.error('Failed to load chatbot config:', error);
        });
}

