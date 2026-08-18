# Vendored third-party bundles

Files here are **build artifacts, not hand-written source**. Do not edit them,
and do not "clean up" `mcp-sdk.js` because a 218 kB minified blob looks out of
place in a repo with no build step — it is committed on purpose. Read this first.

## `mcp-sdk.js` — Model Context Protocol SDK

| | |
|---|---|
| Package | `@modelcontextprotocol/sdk` |
| Version | **1.12.0** (pinned exactly in `devDependencies`) |
| Built with | `esbuild` **0.28.2** (pinned exactly — see *Reproducibility*) |
| Entry point | `scripts/mcp-sdk-entry.js` |
| Rebuild | `npm run build:vendor` |
| Consumed by | `app/mcp-client.js` |

### Why it is vendored rather than loaded from a CDN

The app ships as plain ES modules served straight from jsDelivr — there is no
bundler at deploy time. The SDK's own package uses bare specifiers, and its
published ESM build imports `ajv` transitively, so a browser cannot resolve it
without an importmap pointing at an ESM-compiling host.

That host used to be `esm.sh`, and it was a single point of failure:

- `app/mcp-client.js` imports the SDK **statically**, so it sits in the boot
  module graph. The browser fetches the entire graph before executing any of
  it, which means one unreachable host produced a completely blank page — no
  map, no layers — even though nothing but the chat agent needs MCP.
- That is not hypothetical. A partner organization's network policy started
  blackholing DNS for `esm.sh`, and their users got an 11-second wait followed
  by a white screen (#343).
- `esm.sh` is also the only dependency we could not protect with Subresource
  Integrity: it compiles packages on demand and can rebuild the same version's
  bytes, so there is nothing stable to hash.

Vendoring removes the host entirely. Because jsDelivr serves this repo directly
(`cdn.jsdelivr.net/gh/boettiger-lab/geo-agent@<tag>/app/…`), the relative import
resolves against the same already-working origin that serves `main.js`, and
downstream apps no longer need an importmap at all.

**The file must be committed.** jsDelivr serves the repository as-is; a
build-time-only artifact would not exist at the CDN path.

### Alternatives that were tried and do not work

- `cdn.jsdelivr.net/npm/@modelcontextprotocol/sdk@1.12.0/+esm` → **404**.
  jsDelivr's ESM build does not work for this package. Same for the
  `dist/esm/client/*.js/+esm` paths.
- The raw `dist/esm/client/index.js` from jsDelivr serves fine (200, 12.6 kB)
  but contains a bare `import … from "ajv"`, which the browser cannot resolve
  without importmap entries for the whole transitive tree.

### Reproducibility

`npm run build:vendor` is byte-stable for a given esbuild version, so CI can
rebuild and diff to prove the committed artifact matches the source. It is
**not** stable *across* esbuild versions — 0.28.2 and 0.21.5 produce different
output for identical input. That is why `esbuild` is pinned to an exact version
rather than a caret range: a lockfile refresh that moved the minifier would
otherwise fail the CI check with no real change.

The same applies to the SDK version. Bumping it is a deliberate, separate
change: update `devDependencies`, run `npm run build:vendor`, commit the new
artifact, and update the version in this file.

### Licenses

The SDK is MIT. Bundled transitive code is MIT (`ajv`, `zod`) and ISC
(`zod-to-json-schema`); `uri-js` is BSD-2-Clause and its license banner is
preserved at the end of the artifact (`--legal-comments=eof`). Server-side
dependencies of the SDK — `express`, `cors`, `eventsource`, `pkce-challenge` —
are tree-shaken out and are not present in the bundle.

### Testing

`test/mcp-client.test.js` mocks `../app/vendor/mcp-sdk.js` by relative path. If
this file is ever renamed or moved, that mock must move with it, or the tests
will silently load the real 218 kB bundle instead of the stubs.
