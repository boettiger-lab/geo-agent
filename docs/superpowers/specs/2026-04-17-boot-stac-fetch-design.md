# Drop the MCP `get_collection` preload; move schema to call-time

**Issue:** boettiger-lab/geo-agent#171
**Companion:** boettiger-lab/mcp-data-server#70 (parent-with-children expansion — Gap 1 largely obviated by data-workflows#122 cleaning STAC at source; Gap 2 hex-over-GeoParquet filter stays client-side per discussion)
**Upstream prerequisite:** boettiger-lab/data-workflows#122 (clean STAC parent-with-mixed-roles antipattern)

## Problem

On v3.2.0, geo-agent's boot path fetches each configured collection's STAC JSON **twice**:

1. **Client-direct** in `DatasetCatalog.load()` — feeds the map-layer setup. Fast, parallel, irreplaceable.
2. **Via MCP `get_collection`** in the "preload MCP collection data for system prompt" block (`app/main.js` ~line 219) — populates per-asset `table:columns` and `read_parquet()` paths in the system prompt.

Both resolve to the same S3 gateway. During the 2026-04-16 RGW tail-latency incident (queue depth 600–800, ~1 in 5 serial GETs stalled 6–20s), the MCP path was the bottleneck — MCP server-side traversal is deeper than the client's, and the server was in its cold-start window so every request compounded. Map came up in seconds; chat took minutes.

Beyond the boot-resilience issue, the current split has a conceptual cost: schema-rendering logic lives in `app/dataset-catalog.js` (`_formatSchemaFromMcp`, `_formatSchemaFallback`, `_getSqlAssets`) *and* in MCP (`get_stac_details`). Two implementations of the same thing — one to fall back to the other under some S3 conditions — is a maintenance tax without a benefit proportional to it.

## Direction

**Move schema ownership entirely to MCP. Drop the boot-time MCP preload. Remove per-asset column injection from the system prompt.**

At boot, geo-agent does the minimum needed to render the map and advertise what datasets exist. Schema flows through MCP at call time, via the existing `get_schema` tool which becomes a thin delegator to MCP `get_stac_details`. Agent-facing tool contract is unchanged.

### Why this fits thin-client philosophy

The client gets *smaller*, not larger. All schema-rendering logic moves to one side of the boundary (MCP), shared with any future thin client. `dataset-catalog.js` goes back to being a map-layer builder.

### Why not route everything through MCP (Option B)

Routing `DatasetCatalog.load()` itself through MCP is an orthogonal goal (boettiger-lab/geo-agent#167). It requires dual `https://` + `s3://` hrefs in the MCP response and makes boot strictly worse under S3 incidents until server-side caching lands. Deferred — revisit once boettiger-lab/mcp-data-server#65's caching is in place.

## Architecture

Boot now has one I/O path; schema flows lazily through MCP when the agent needs it.

| | Before | After |
|---|---|---|
| Client-direct STAC fetch | Feeds map layers + prompt schemas | **Feeds map layers only** |
| MCP `get_collection` preload | Feeds prompt schemas | **Deleted** |
| System prompt content | Paths + per-asset columns + coded values | **Paths + layer IDs + titles + descriptions** |
| Schema lookup | Pre-computed, in prompt | **Lazy, via `get_schema` delegator at call time** |

Boot-critical path is now bounded by client-direct STAC fetches plus MapLibre style load — same critical path as the map. No additional hop.

## Boot flow (`app/main.js`)

Before:

```
fetch config (parallel)
  → build layout
  → catalog.load()                   [STAC fetch #1]
  → mapManager init + addLayers
  → mcp.connect()                    [fire-and-forget]
  → mcp.listTools()
  → [MCP get_collection preload ×N]  [STAC fetch #2 via MCP]
  → generatePromptCatalog()
  → mcp.getPrompt('geospatial-analyst')
  → Agent + UI
```

After:

```
fetch config (parallel)
  → build layout
  → catalog.load()                   [STAC fetch, only one]
  → mapManager init + addLayers
  → mcp.connect()                    [fire-and-forget]
  → mcp.listTools()
  → generatePromptCatalog()          [from client-direct data only]
  → mcp.getPrompt('geospatial-analyst')
  → Agent + UI
```

`mcp.listTools()` and `getPrompt()` remain — they're fast and not the culprit. If MCP is slow at boot, `listTools()` times out gracefully via the existing fallback at `main.js:200-216` that manually registers `query`.

## `get_schema` as a thin delegator

Signature stays identical. Implementation:

```js
{
  name: 'get_schema',
  description: '...',  // unchanged
  inputSchema: { type: 'object', properties: { dataset_id: {...} }, required: ['dataset_id'] },
  execute: async ({ dataset_id }) => {
    try {
      const result = await mcp.callTool('get_stac_details', { dataset_id });
      return filterHexPreferred(result);  // client-side hex-over-GeoParquet filter
    } catch (err) {
      return JSON.stringify({
        success: false,
        error: 'Schema service unavailable. If this persists, the MCP server may be down.'
      });
    }
  }
}
```

`filterHexPreferred()` is a small private helper in `map-tools.js`. When the MCP response lists both a hex asset and a full GeoParquet asset for the same dataset, it drops the GeoParquet from the returned text. Heuristic matches today's `_getSqlAssets`: href contains `/hex/` or asset title contains `hex`/`h3`. This filter stays client-side per the agreement in geo-agent#171's discussion.

System prompt wording is unchanged — `"call get_schema(dataset_id) before your first SQL query against a dataset"`. Contract to the agent is preserved; only the implementation changes.

## Concrete deletions and edits

### `app/main.js`

Delete the block labeled `/* ── 5b. Preload MCP collection data for system prompt ──────────── */` (~lines 219-248). ~30 lines.

### `app/dataset-catalog.js`

Remove:
- `this.mcpCollections` Map (constructor)
- `setMcpCollection(id, data)`
- `_getSqlAssets(mcpData)` — relocated to `map-tools.js` as `filterHexPreferred` helper
- `_formatSchemaFromMcp(ds, mcpData)`
- `_renderOneAssetSchema(title, s3Path, cols)` — no callers after the above go
- `_formatSchemaFallback(ds)`
- `formatSchema(id)` public method — no callers after `get_schema` is rewritten

Simplify `_renderSqlPaths(ds)` to use only `ds.parquetAssets` (drop the `mcpCollections.get(ds.id)` branch).

Kept: `extractColumns()`, `extractParquetAssets()`, `extractMapLayers()`, `processCollection()`, `load()`, `generatePromptCatalog()`, `getMapLayerConfigs()`. These feed map-layer construction and the slimmed system-prompt catalog.

Net: ~180 lines deleted, ~5 lines edited.

### `app/map-tools.js`

Rewrite `get_schema` per the delegator spec above. Add `filterHexPreferred()` as a private helper in the same file. Tool description unchanged.

### `app/system-prompt.md`

No changes required. Wording about calling `get_schema` before first SQL already matches the post-change contract.

### Documentation

One-line note in `app/README.md` and/or `docs/guide/configuration.md` that schema now flows through MCP at call time rather than being pre-injected at boot. Not load-bearing.

## Error handling and partial-failure modes

**1. MCP not connected when `get_schema` is called.** `mcp.callTool()` triggers lazy reconnect via `mcp-client.js`. If MCP is truly unreachable, the delegator returns a structured failure and the agent decides whether to retry on its next turn. SQL `query` would fail equivalently if called next — user sees a coherent "MCP is down" state, not a confusing partial state.

**2. MCP up, but the underlying STAC fetch times out.** Server-side partial-result handling (scope of mcp-data-server#65) renders this as a best-effort response with skipped assets noted. Delegator passes through unchanged.

**3. `filterHexPreferred()` misidentifies.** Strict port of today's `_getSqlAssets` heuristic — not a new risk surface. Worst case: agent gets the wrong path, SQL errors, recovery is one extra `get_stac_details` round-trip.

**What we're not building:**

- **No client-side retry loop.** Tool calls are user-initiated; silent retries make failures look like hangs.
- **No client-side schema cache across queries.** Conversation context already retains previous `get_schema` results — a client cache would duplicate it with no benefit.
- **No pre-warming at boot.** The whole point is boot does less; the user pays the schema round-trip only if they ask a question that needs it.

## Verification

### Manual smoke tests (staging deploy on `@main`)

1. **Boot under healthy S3** — chat-ready within ~1s of map-ready. Network panel during boot shows `initialize`, `tools/list`, `prompts/get` to MCP and no `get_collection` calls.
2. **Boot under slow / absent MCP** — stop MCP pod, reload. Map loads; chat UI appears; agent can answer non-SQL questions. Restart MCP; next SQL query succeeds.
3. **Schema coverage:**
   - `get_schema("pad-us-4.1-combined")` → paths + coded-value lists for `State_Nm`, `GAP_Sts`, `Own_Type`
   - `get_schema("svi-2022")` → hex-asset columns (`RPL_THEMES`, `FIPS`, ...), not full-GeoParquet columns (regression guard for #166's fix)
   - `get_schema("wyoming-wildlife-lands")` — after data-workflows#122, this is a pure grouping; MCP returns grouping/no-schema response; delegator forwards unchanged
   - `get_schema("wyoming-wgfd-elk-crucial")` → 6 columns including `RANGE`, `Acres`, `SQMiles`
4. **Hex-over-GeoParquet filter** — pick a dataset with both; `get_schema` output lists only the hex path.
5. **First-query round-trip cost** — warm-MCP session: "show me X where Y" → first SQL execution should be within one MCP round-trip (~100ms) of pre-change behavior.

### Regression guards (post-rollout production logs)

- `query` calls preceded by `get_schema` in the same session — should stay roughly equal to today's ratio. If it drops, prompt wording needs tightening.
- SQL errors mentioning unknown columns — should stay flat or decrease. Spikes indicate filter or MCP response issues.
- `get_stac_details` call frequency — should stay flat. Spikes indicate agents are fallbacking because `get_schema` is underperforming.

## Rollout sequencing

1. **Land data-workflows#122 STAC cleanup.** Restart both app and MCP deployments (both cache STAC at startup).
2. **Confirm mcp-data-server#70 status.** Gap 1 is largely obviated by #122. Gap 2 (hex-over-GeoParquet) stays client-side. Either way, no server-side blocker for this change once #122 is deployed.
3. **Land the geo-agent PR.** Merges to `main`, picked up by `@main` apps via jsDelivr.
4. **Verify on `padus.nrp-nautilus.io`** (@main) first. If healthy, cut a geo-agent release tag (e.g. v3.3.0).
5. **Coordinate downstream pinned apps through geo-agent-ops.** The two wyoming apps (`wyoming`, `wyoming-public-demo`) need the `layers-input.json` child-listing migration — configure individual children like `wyoming-wgfd-elk-crucial` instead of the now-empty `wyoming-wildlife-lands` parent — in the same pin-bump PR that picks up the new geo-agent version.

## Acceptance

- Boot-time MCP round trips drop from N (one per configured collection) to 0.
- During a simulated S3 tail-latency incident, chat is responsive within seconds of page load, matching map-ready time.
- `get_schema(any-configured-collection)` returns column information within one MCP round-trip, equivalent to pre-change prompt-injected content.
- `get_schema(svi-2022)` returns hex-asset columns (regression guard for #166).
- `app/dataset-catalog.js` contains no `mcpCollections`, `_formatSchemaFromMcp`, `_formatSchemaFallback`, `_getSqlAssets`, or `formatSchema` references.

## Non-goals

- **Not routing `DatasetCatalog.load()` through MCP** (boettiger-lab/geo-agent#167) — requires dual-href support; deferred.
- **Not changing `browse_stac_catalog` behavior** — boettiger-lab/mcp-data-server#65's hardening is the relevant work; this proposal doesn't touch that path.
- **Not adding MCP caching** — caching in mcp-data-server (also in #65) makes this proposal better but isn't a precondition. Uncached, the cost is one extra round-trip per new dataset per session, paid at user-initiated SQL time rather than at boot.
