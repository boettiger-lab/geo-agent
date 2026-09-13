# Design decision: data scope is ambient, never a model argument

**Status:** settled (2026-09-13). Revisit only if an app legitimately needs to reach
data outside its own `layers-input.json`.
**Tracking issue:** #354 (client half, shipped v3.28.1). Server half:
[mcp-data-server#420](https://github.com/boettiger-lab/mcp-data-server/issues/420) / PR #421.

## The recurring question

"The agent answered about a dataset this app doesn't configure — can we stop that?"
(observed on ca-30x30). The tempting fixes all turn out to be wrong, and we worked
through four of them before finding the real one. This note records the answer so
we stop re-deriving it.

## The decision

**Which data exists is a property of the session, declared once by the deployment —
never a parameter the model supplies per call.**

Every leak traced to one inversion: `catalog_url` / `catalog_token` were tool
arguments, so the model re-chose its data universe on every call. They were added
in good faith for private-STAC apps (#187) — the *intent* was always session scope;
tool arguments were just the only channel the API offered at the time.

The fix was to move scope out of the JSON-RPC body entirely, mirroring a refactor
this stack had already done once for S3 credentials (which moved from per-request
params to per-deployment env, and *gained* capability by doing so).

## What we rejected, and why

**Client-side argument validation** (reject calls naming a foreign catalog). Re-decides
per call what the deployment should state once, and cannot bind a parameter the model
is free to supply. It also doesn't work: `injectInlineStac` ends with
`if (!collection) return args`, so an unknown ID passes through whatever the guard does.

**Not registering `get_stac_details`.** It looks like a discovery tool and isn't — it has
six in-app roles (get_schema gaps, 404 path recovery, categorical values, `id_property`
lookup, sub-datasets, get_schema's own fallback). `browse_stac_catalog` is the only
genuinely unscoped tool, and it *is* the one that became opt-in.

**A sidecar STAC catalog listing only sanctioned datasets.** The wyoming app already
ships one, and it did not lock anything down — its replica still pointed
`STAC_CATALOG_URL` at the public catalog. A curated catalog governs *curation*; it is
orthogonal to *confinement*.

**A `discovery` flag in `layers-input.json`.** See below — deriving beats configuring.

## The shipped shape (client side)

- The client **never sends** `catalog_url` / `catalog_token`. They were vestigial from
  v3.5.0 (inline STAC forwarding superseded them) and removed in v3.28.1.
- `injectInlineStac` (`app/main.js`) injects our cached STAC for any ID we hold,
  **regardless of what catalog the model names** — inline wins MCP's resolution order
  (`collection` → deployment default). An ID we don't hold passes through, and the
  *server* decides, against its own catalog.
- `toStacDict` resolves child collection IDs too (#355), so container sub-datasets
  forward inline rather than falling through to the server's default catalog.
- `get_stac_details` stays registered and stays recommended — for *configured* data.
  Only the "for datasets outside your app" framing was removed.

## Why the discovery flag is derived, not configured

`generatePromptCatalog({ discovery })` takes its value from
`toolRegistry.has('browse_stac_catalog')` — live registry state, not app config.

This is the non-obvious call, so: whether that tool exists is decided **server-side**
(`STAC_DISCOVERY` on the MCP deployment). A client-side config field duplicating that
decision would have to be hand-synced across every app, and would silently lie whenever
it drifted — telling the model to call a tool that isn't there, or staying quiet about
one that is. Reading the registry is correct by construction and needs no config in any
app. Remote tools are registered well before the prompt is built, so the value is always
available.

When discovery is off, the preamble names the closed door explicitly rather than simply
going quiet. That matters because the MCP server's `query` tool description historically
opened with "call `browse_stac_catalog` first" — text we cannot edit from here.

## What this deliberately does *not* close

The `query` tool still executes arbitrary read-only SQL and can reach any readable S3
path via `read_parquet()`; `filter_by_query` and `render_chart` also carry
model-authored SQL to the same endpoint. Removing discovery removes the *index*, not
the *access*.

That was scoped out on purpose. Constraining it means binding dataset references to
handles resolved server-side — deployment-level routing of the kind `s3config.py`
already does for S3 endpoints — and is a much larger change. Client-side SQL inspection
was considered and rejected as unenforceable: it is a speed bump, not a boundary, and
would read as one.

## Footnote for future readers

geo-agent#355 (child-collection inlining) shipped alongside this work and is sometimes
described as fixing a live failure. A fleet scan
([geo-agent-ops#172](https://github.com/boettiger-lab/geo-agent-ops/issues/172))
showed it was **not** firing in production: triggering it needs container collections
*and* a catalog that isn't the MCP's default, and no app had both. It is useful
insurance, not evidence that this class of bug was actively biting.
