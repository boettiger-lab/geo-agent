# Sidebar layout — design

**Status:** design, pre-implementation
**Tracking issue:** [boettiger-lab/geo-agent#127](https://github.com/boettiger-lab/geo-agent/issues/127) (sidebar half only — plotting is a separate follow-up spec)
**Date:** 2026-04-15

## Goal

Offer an alternative to the current small floating chat panel: a full-height, resizable sidebar that pushes the map to a narrower column and houses the chat plus the layer-controls menu. The existing floating chat remains the default; apps opt in to the sidebar via `layers-input.json`. Chat mechanics are unchanged and do not duplicate — a single `ChatUI` class renders correctly inside either shell.

This spec covers the layout/shell refactor only. The plotting/chart-rendering half of issue #127 is deliberately deferred to a separate spec so that plotting design decisions (chart library, tool API shape, sandboxing, data flow) can be made against a stable layout rather than hypothetical one.

## Non-goals

- **Plotting / chart rendering.** Follow-up spec.
- **A dedicated "last chart" display panel.** The config block is designed to admit a future `plot_panel: true` key without restructuring, but no such panel is built now.
- **Redesign of the layer-controls menu.** Only its mount point changes in sidebar mode; markup and behavior are untouched.
- **Redesign of the legend or the H3/draw buttons.** They remain free-floating overlays on the map in both modes.
- **Changes to `agent.js`, `tool-registry.js`, `map-manager` layer logic, `mcp-client.js`, or `dataset-catalog.js`.** This is purely a UI-shell refactor.
- **Automated tests.** The repo has none today; adding a test framework is not part of this work.

## Architecture

Three modules change and one new module is added. The split isolates **chat mechanics** (single source, unchanged conceptually) from **outer chrome** (layout-manager's responsibility).

### New: `app/layout-manager.js`

Exports one function, called once from `main.js` before `ChatUI` is constructed:

```js
export function buildLayout(appConfig) { … }
// returns { chatMount, menuMountId }
```

Internally branches on `appConfig.sidebar?.enabled`:

- **Floating mode (default)** — builds the current translucent `#chat-container` DOM and appends to `<body>`. Returns chat refs + `menuMountId: 'menu'`.
- **Sidebar mode** — sets `body.classList.add('sidebar-mode')`, builds the sidebar scaffold (header, layers pane, chat region, footer), appends to `<body>`, attaches the resize handle + collapse button, initializes the `--sidebar-width` CSS variable. Returns chat refs + `menuMountId: 'sidebar-layers-pane'`.

### Refactored: `app/chat-ui.js`

Constructor signature changes:

```js
new ChatUI(agent, config, mount)
// mount = {
//   container,      // outer element (for collapse class, scope)
//   messages,       // scrollable message list
//   input,          // text input
//   send,           // send button
//   mic,            // mic button (may be null)
//   header,         // header element
//   footer,         // full footer element
//   footerRight,    // right-zone subcontainer
// }
```

All `document.getElementById(...)` calls inside `chat-ui.js` are replaced by references from `mount`. The class becomes mount-agnostic: the same instance renders correctly inside either shell.

Moved to layout-manager:

- `initResize()` — resize is layout-manager's responsibility in both modes. In floating mode it reproduces the current corner-drag behavior (width + max-height). In sidebar mode it drives the left-edge handle and the `--sidebar-width` CSS variable.
- `restructureFooter()` — footer zones are built correctly upfront by layout-manager.

Modified: `initLinks()` stays, but always outputs into `mount.footer`'s left zone (the header is no longer used for links — see "Footer links consolidation" below).

### Tweaked: `app/map-manager.js`

No signature change. `generateMenu(mountId)` already accepts a mount id. Layout-manager passes `'menu'` in floating mode and `'sidebar-layers-pane'` in sidebar mode.

### Tweaked: `app/main.js`

Wiring change:

```js
import { buildLayout } from './layout-manager.js';
// …
const layoutRefs = buildLayout(appConfig);
// … existing catalog / map / tools setup …
mapManager.generateMenu(layoutRefs.menuMountId);
// …
const ui = new ChatUI(agent, appConfig, layoutRefs.chatMount);
```

## Configuration surface

New top-level block in `layers-input.json`:

```json
"sidebar": {
  "enabled": true,
  "default_width": 420,
  "title": "Data Assistant"
}
```

| Key             | Type    | Default           | Purpose                                                                                    |
| --------------- | ------- | ----------------- | ------------------------------------------------------------------------------------------ |
| `enabled`       | boolean | `false`           | Opts in to sidebar mode. Omitting the whole `sidebar` block is equivalent to `false`.      |
| `default_width` | number  | `420`             | Starting width in px. User's last-dragged width (localStorage) overrides on reload.        |
| `title`         | string  | `"Data Assistant"` | Text shown in the sidebar (and floating-mode) header. Replaces the current hardcoded text. |

`docs/guide/configuration.md` gains a "Sidebar layout" subsection documenting these keys.

## DOM shapes

Both shapes are built in JS by `layout-manager.js`; downstream `index.html` does **not** contain either. IDs that `ChatUI` interacts with (`#chat-messages`, `#chat-input`, `#chat-send`, `#chat-mic`, `#auto-approve-btn`, `#settings-btn`, `#model-selector`) are identical in both shapes.

### Floating mode

```
#chat-container
├── .resize-handle           (top-left corner — drag to resize width + max-height)
├── #chat-header
│   ├── h3  (title from config)
│   └── #chat-toggle (−)
├── #chat-messages
├── #chat-input-container
│   ├── #chat-input
│   ├── #chat-mic (if voice enabled)
│   └── #chat-send
└── #chat-footer
    ├── footer-left (links: github, carbon, docs)
    └── #chat-footer-right (#auto-approve-btn, #settings-btn?, #model-selector)
```

### Sidebar mode

```
body.sidebar-mode
├── #map                      (width reduced via right: var(--sidebar-width))
├── #menu                     (empty — layers render inside sidebar)
├── #sidebar-show-btn         (floating button on map, visible only when collapsed)
└── #sidebar
    ├── .sidebar-resize-handle     (left edge, full-height)
    ├── #sidebar-header
    │   ├── h3 (title from config)
    │   └── #sidebar-hide (→)
    ├── #sidebar-layers-pane       (MapManager.generateMenu mounts here)
    ├── #chat-messages
    ├── #chat-input-container (#chat-input, #chat-mic, #chat-send)
    └── #sidebar-footer
        ├── footer-left (links: github, carbon, docs)
        └── #chat-footer-right (#auto-approve-btn, #settings-btn?, #model-selector)
```

## UX details

### Resize

- 6px-wide grab strip on the sidebar's left edge, with a subtle visual border that intensifies on hover (matches the existing `.resize-handle` aesthetic).
- On drag, layout-manager updates `document.documentElement.style.setProperty('--sidebar-width', newW + 'px')`. `#map { right: var(--sidebar-width, 0) }` reflows automatically.
- `map.resize()` fires on a `requestAnimationFrame` loop during drag and one final time on drag-end.
- Bounds: `min(max(280, w), 0.6 * window.innerWidth)`. Re-clamped on window resize so the sidebar never exceeds 60% of the visible viewport.
- Persistence: drag-end writes width to `localStorage['geo-agent-sidebar-width']`. On boot, a stored value overrides `config.sidebar.default_width` if still within bounds for the current window.

### Collapse

- `#sidebar-hide` button in the sidebar header toggles `body.classList.toggle('sidebar-collapsed')`.
- CSS sets `--sidebar-width: 0` and `#sidebar { transform: translateX(100%) }` when collapsed. Transition ~200ms.
- `map.resize()` fires on `transitionend`.
- `#sidebar-show-btn` is a floating button pinned to the top-right of the map, visible **only** when `body.sidebar-mode.sidebar-collapsed`. Same glassmorphism styling as `#h3-toggle`. Click restores the sidebar.
- Collapsed state is **not** persisted across reloads — a user who refreshes gets the sidebar back, avoiding a confusing "my chat vanished!" moment.

### Narrow-viewport fallback

Single `@media (max-width: 700px)` block in `sidebar.css`:

- `#sidebar` switches to `position: fixed; right: 0; top: 0; bottom: 0; z-index: 1000`.
- `#map { right: 0 }` — sidebar overlays rather than pushes.
- `--sidebar-width` pinned to `min(400px, 90vw)`; drag-resize is disabled.
- Starts collapsed by default so mobile/tablet users see the full map.

### Styling

- New file `app/sidebar.css`. All selectors are either scoped to `body.sidebar-mode …` or target IDs that only exist in sidebar mode, so unconditional loading is safe.
- Downstream HTML templates add one `<link>` for `sidebar.css`.
- `chat.css` keeps all inner-chat styling (messages, tool-blocks, approval buttons, settings panel). That code is mode-agnostic and continues to be authoritative for the chat's appearance in both shells.
- `body.sidebar-mode` removes the glassmorphism blur from chat bubbles (the sidebar background is opaque) and adjusts z-index on the floating map overlays (legend, H3-toggle) as needed to stay visible when the map is narrow.

### Footer links consolidation

A minor UX change that applies in **both** modes: `initLinks()` currently places `docs` + `github` in the chat header (`.header-links`) and `carbon` in the footer left. The new behavior places all three in the footer left, leaving the header free of links. This is independent of the sidebar work but lands with it — it's the same code path and the header-less arrangement is consistent between floating and sidebar.

## Downstream HTML surface

With layout-manager owning DOM construction, the downstream `index.html` shrinks to:

```html
<div id="map"></div>
<div id="menu"></div>
<script type="module" src="…/main.js"></script>
```

(plus existing CSS and SDK imports — now including `sidebar.css`). The `#chat-container` block is removed entirely. Every downstream app needs this one-time HTML trim, whether or not it opts in to sidebar mode, because layout-manager will build its own floating DOM otherwise.

## Migration plan

Rollout sequencing is coordinated through **[`geo-agent-ops`](https://github.com/boettiger-lab/geo-agent-ops)** (private). Downstream apps pinned to older geo-agent SHAs can remain on those SHAs indefinitely; migration happens on the ops repo's schedule rather than being forced by this PR.

1. **Library PR** — layout-manager + ChatUI refactor + sidebar.css + updated library `app/index.html`. Merge to `main`.
2. **geo-agent-template PR (this work)** — minimal HTML + `sidebar.css` link. `layers-input.json` gets a commented-out example `sidebar` block showing how to opt in; `enabled` remains absent by default so the template's current appearance is preserved.
3. **Validate on `@main`-pinned demos** — flip one demo to `sidebar.enabled: true` and confirm parity (chat flow, tools, voice, resize, collapse, narrow viewport).
4. **Coordinate production rollout via `geo-agent-ops`** — pinned production apps bump their SHA and update their HTML on `geo-agent-ops`'s schedule, not in a single batched PR.

## Verification

No automated tests (repo has none today). Manual verification on `cd app && python -m http.server 8000`, running through both modes:

**Mode-agnostic checks** (should pass identically in floating and sidebar):

- User message → agent response → tool-call approval → result rendering all work.
- Tool blocks render with collapsible details intact.
- Voice input records, transcribes, and drops into the input field.
- Model selector, auto-approve button, settings panel (in user-provided-API-key mode) all function.
- Welcome message + example buttons work.
- Footer links (github, carbon, docs) appear correctly, in the footer-left zone.

**Sidebar-specific checks:**

- Dragging the left edge resizes fluidly; `#map` narrows with it; MapLibre reflows without artifacts.
- Width clamps at 280px and 60vw; clamp updates on window resize.
- Collapse slides the sidebar out; a floating "show" button appears; clicking it restores. Map resizes at `transitionend`.
- Reload preserves resized width (from localStorage); does **not** preserve collapsed state.
- Below 700px viewport width, sidebar auto-overlays rather than pushes, starts collapsed, drag-resize disabled.
- Layer menu renders correctly at the top of the sidebar with all checkboxes / version selectors / basemap toggles functional.
- Floating-mode appearance after the refactor is visually indistinguishable from the current state, except for the header → footer link consolidation.

geo-agent-template gets a smoke test once updated. Production apps are smoke-tested one by one as they migrate under `geo-agent-ops`'s direction.

## Risks and open questions

- **Floating-mode parity regression.** Because the floating DOM now comes from JS instead of HTML, a tiny CSS specificity or ordering bug could cause subtle visual drift. Mitigation: check the rendered DOM + computed styles against the current state during PR review.
- **MapLibre resize cost during drag.** Calling `map.resize()` every animation frame is cheap on desktop but has been observed to stutter on low-end mobile. Mitigation: on mobile (narrow-viewport overlay mode), resize is disabled anyway; if stutter appears on mid-tier devices in push mode, fall back to resizing only on drag-end.
- **Layer menu cramped in a narrow sidebar.** At `default_width: 420` the layer menu fits comfortably, but at the 280px minimum it may look tight. Accepted cost — the menu's internal redesign is out of scope, and users at the minimum width are making a tradeoff consciously.
- **`#menu` div remaining in downstream HTML.** In sidebar mode, layers render into `#sidebar-layers-pane` and the downstream `<div id="menu">` sits empty. It's harmless (no default styling applies) and simplifies the migration (one less HTML diff). If this feels wrong, a later cleanup can drop `#menu` from the template entirely.
