/**
 * Bundle entry point for the vendored MCP SDK (app/vendor/mcp-sdk.js).
 *
 * The browser build of this app has no bundler — modules are served as-is from
 * jsDelivr — so the SDK's bare specifiers (and its transitive `ajv` import)
 * cannot be resolved at runtime without an importmap pointing at a third-party
 * ESM host. Pre-bundling here removes that host from the boot path entirely.
 *
 * Re-export only what `app/mcp-client.js` actually uses; esbuild tree-shakes
 * the rest (the server-side surface — express, cors — drops out).
 *
 * Rebuild with `npm run build:vendor`. See app/vendor/README.md.
 */
export { Client } from '@modelcontextprotocol/sdk/client/index.js';
export { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
