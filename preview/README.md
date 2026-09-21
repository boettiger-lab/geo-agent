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

Deploys are restricted to branches matching `preview/*` (a deployment-branch
policy on the `github-pages` environment). Push the branch you want to look at
under that prefix, then dispatch the workflow on it:

```bash
git push -u origin HEAD:preview/<name>
gh workflow run gh-pages.yml --ref preview/<name>
```

It lands at <https://boettiger-lab.github.io/geo-agent/preview/> and the docs
site keeps its usual URLs, because the preview is staged into the built docs
tree rather than replacing it.

The Pages site has a single deployment slot, so one preview is live at a time
and the next `main` push to `docs/**` replaces it. Nothing is pinned and no
downstream app is involved — the preview serves that branch's `app/` directly,
via relative imports, so pushing more commits and re-dispatching is the whole
iteration loop.

## What the fixture covers

Five real collections, chosen as the smallest set that still exercises every
layout surface:

| Layer | Exercises |
|---|---|
| PAD-US fee (vector, visible) | categorical vector legend, tooltips |
| NLCD (raster COG) | categorical raster legend |
| Irrecoverable carbon (raster COG) | continuous colorbar legend |
| Federal trails (vector) | `layer_type: line` |
| USGS fire perimeters (vector, visible) | reactive `control` slider, animated |

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
