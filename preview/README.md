# Layout preview fixture

`layers-input.json` here is a **test fixture, not a demo**. It exists because the
coverage table in `AGENTS.md` says of `chat-ui.js`, `map-manager.js`,
`layout-manager.js`, `map-draw.js`, `h3geo.js` and `voice-input.js`:

> Browser-bound (DOM, MapLibre, MediaRecorder). Verify visually in a deployed
> app — no harness yet.

This is that harness. The Pages workflow publishes the repo's own `app/`
directory, with this config in place of `app/layers-input.json`, so a change to
browser-bound UI can be looked at in a real browser before it merges.

## Publishing a preview

> The operational runbook — mirror-push pattern, verification, variants,
> gotchas — is the **`deploy-preview`** skill in `.claude/skills/`. This file
> covers what the fixture *is*; that one covers how to ship it.


Deploys are restricted to branches matching `preview/*` (a deployment-branch
policy on the `github-pages` environment). Push the branch you want to look at
under that prefix, then dispatch the workflow on it:

```bash
git push -u origin HEAD:preview/<name>
gh workflow run gh-pages.yml --ref main
```

Dispatch on `main`, not on the preview branch: `workflow_dispatch` runs the
workflow file from the ref it is dispatched on, so dispatching on a branch
uses that branch's copy, which goes stale whenever the workflow changes. The
build stages every `preview/*` ref regardless of what triggered it.

It lands at `https://boettiger-lab.github.io/geo-agent/preview/<name>/`, and the
docs site keeps its usual URLs, because previews are staged into the built docs
tree rather than replacing it. `/preview/` lists whatever is published.

**Every `preview/*` branch is rebuilt on each deploy**, whichever ref triggered
it. Pages has a single deployment slot, so staging only the triggering branch
meant one preview silently took every other offline and a push to `main` took
them all; rebuilding the set keeps them additive. A preview lives until its
branch is deleted.

Nothing is pinned and no downstream app is involved — a preview serves that
branch's `app/` directly, via relative imports, so pushing more commits and
re-dispatching is the whole iteration loop.

## Logos in the fixture

All three header slots are filled with real marks, so spacing and truncation
can be judged as a deployed app would show them:

- **GLEN** and **DSE** come from `app/assets/` as library defaults, needing no
  configuration. The GLEN one is a placeholder until a real mark exists.
- **BOSL** (`bosl-logo.svg`, vendored from <https://bosl.ucsb.edu/>) fills the
  partner slot, standing for a sister organisation. It is a self-contained
  badge with its own dark background, so it needs no light/dark variant.

## Editing the fixture

`layers-input.json` here is a **fixed point of `json.dumps(..., indent=2)`**
plus a trailing newline: format it and you get the same bytes back. So a
programmatic edit produces a diff of only what changed.

Round-tripping a file through a formatter it does not already match reformats
it wholesale. One session turned a six-line addition into a 577-line diff that
way. Nothing catches it — the tests still pass, and the churn only shows up in
review, where it buries the actual change.

**The settings are per file.** Check before editing, rather than assuming:

```python
raw = open(path).read()
raw == json.dumps(json.load(open(path)), indent=N) + nl   # find the N and nl that hold
```

| File | Fixed point of |
|---|---|
| `preview/layers-input.json` | `indent=2`, trailing newline |
| `preview/variants/*.json` | `indent=2`, trailing newline |
| `app/layers-input.json` | **`indent=4`, no trailing newline** |

`app/layers-input.json` is the one to be careful with: it is what downstream
apps copy from, and reaching for `indent=2` out of habit rewrites all 66 lines
of it.

## Variants

`preview/variants/<name>.json` is a **shallow patch** over the base fixture,
published alongside it at `/preview/<branch>/<name>/`. One branch can therefore show
several configurations at once — a light and a dark theme, say — without
duplicating the whole fixture, which would then drift out of sync.

```json
// preview/variants/light.json
{ "theme": "light" }
```

`brand.json` is the same fixture under an invented house palette, to show that
a downstream app can recolour from config alone. It is a made-up colour scheme,
not anyone's real branding.

Top-level keys in the patch replace those in the base; there is no deep merge,
so patch whole blocks rather than individual nested fields.

## What the fixture covers

Sixteen real collections across twelve groups. The count is deliberate: a
three-layer panel does not show whether the layout survives a realistic list,
so the fixture is sized to crowd it. Between them they cover:

| Layer | Exercises |
|---|---|
| PAD-US fee (vector, visible) | categorical vector legend, tooltips |
| NLCD, RAP cover (raster COG) | categorical raster legend, colormaps |
| Irrecoverable carbon, MOBI richness, GHS population (raster COG) | continuous colorbar legends |
| Federal trails (vector) | `layer_type: line` |
| SVI, flood hazard, wetlands (vector) | further categorical legends |
| USGS fire perimeters (vector, visible) | reactive `control` slider, animated |
| PAD-US easement, critical habitat, watersheds, ecoregions, IPLC lands | group nesting and list density |

Plus `sidebar.enabled`, charts, geocoder, draw, upload, geolocate and the
footer links. The fire slider and a visible legend are deliberately on at once
— that pairing is the collision from
[#359](https://github.com/boettiger-lab/geo-agent/issues/359), and the stock
`app/layers-input.json` (two collections, no sidebar, no slider) cannot show it.

No `config.json` is deployed, so no LLM is configured and the chat will not
answer. That is intentional: previews carry no secrets, and the point is the
visual layout.

## Keeping it working

The collection IDs, URLs and asset IDs are copied from a live catalog, so this
file can rot if those move. If a preview comes up with missing layers, check
`preview/layers-input.json` against the catalog before assuming the branch
broke something.

## The sample export

`preview/sample-export.html` is a **real exported transcript**, published with
the rest of a branch's preview at
`https://boettiger-lab.github.io/geo-agent/preview/<branch>/sample-export.html`.

It is here because the export is a *downloaded artifact*, which the live app
preview cannot show: the preview carries no LLM, so no conversation can be run
to produce one, and nobody should have to run a conversation to review what the
saved file looks like. This is that file, one click away.

Regenerate it after any change to the export:

```bash
node preview/tools/make-sample-export.mjs
```

The generator drives the actual `ChatUI` export path in jsdom — nothing about
it is stubbed — so the committed HTML is byte-for-byte what a user's download
contains. It lives in `tools/` because the staging step publishes `preview/*`
at depth 1, and a build script served next to the app is noise.

The transcript is a fixture, but **the numbers in it are real**: every query in
it was run against the public bucket and the output pasted back. A sample
carrying invented figures would be worse than no sample.
