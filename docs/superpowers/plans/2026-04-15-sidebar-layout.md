# Sidebar Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in, full-height resizable sidebar layout to geo-agent — alternative to the current floating chat panel — without duplicating any chat logic. Layout is chosen by config; the existing `ChatUI` class becomes mount-agnostic so a single instance renders correctly inside either shell.

**Architecture:** A new `app/layout-manager.js` module owns outer-chrome DOM construction (floating vs sidebar) and returns mount refs. `ChatUI` is refactored to consume a `mount` object instead of calling `document.getElementById()` on hardcoded IDs. Sidebar-mode CSS lives in a new `app/sidebar.css`, scoped to `body.sidebar-mode`. The library's `index.html` shrinks to `<div id="map">` + `<div id="menu">` + the module `<script>` tag — DOM construction moves into JS.

**Tech Stack:** ES modules (no build step), MapLibre GL JS, plain CSS (no framework), `localStorage` for width persistence, CSS variables for push-layout.

**Scope Note:** The repo has no automated test framework. This plan uses manual verification (load `cd app && python -m http.server 8000`) in place of TDD. Steps are still small and each task ends in a commit.

**Design spec:** `docs/superpowers/specs/2026-04-15-sidebar-layout-design.md`

**Tracking issue:** [boettiger-lab/geo-agent#127](https://github.com/boettiger-lab/geo-agent/issues/127) (sidebar half only; plotting is a follow-up spec)

---

## File Structure

**New files:**
- `app/layout-manager.js` — single-export module: `buildLayout(appConfig) → { chatMount, menuMountId }`. Builds both floating and sidebar DOM; owns resize + collapse behavior.
- `app/sidebar.css` — all sidebar-mode styling. Selectors are either scoped to `body.sidebar-mode …` or target IDs that only exist in sidebar mode, so unconditional loading is safe.

**Modified files:**
- `app/main.js` — imports `buildLayout`, calls it before any other UI wiring, passes `menuMountId` to `MapManager.generateMenu()`, passes `chatMount` to the `ChatUI` constructor.
- `app/chat-ui.js` — constructor signature gains a `mount` parameter. All `document.getElementById()` calls for chrome elements are replaced with refs from `mount`. `restructureFooter()` is deleted (footer zones are built upfront by layout-manager). `initResize()` is deleted (layout-manager owns resize in both modes). `initLinks()` stays but always outputs to `mount.footer`'s left zone.
- `app/index.html` — `#chat-container` block removed; `<link rel="stylesheet" href="sidebar.css">` added.
- `app/layers-input.json` — optional, for local dev: add a commented-out `sidebar` example block (or enable it for library-owner local testing; either way the committed state defaults to floating mode).
- `docs/guide/configuration.md` — new "Sidebar layout" subsection documenting `sidebar.enabled`, `sidebar.default_width`, `sidebar.title`.

**Downstream (separate repo) — `geo-agent-template`:**
- `index.html` — remove the `#chat-container` block; add `<link>` for `sidebar.css` from jsDelivr.
- `layers-input.json` — add a commented-out `sidebar` block as an opt-in example.

---

## Task 1: Extract floating-mode DOM construction to `layout-manager.js`

**Goal:** Move the `#chat-container` DOM tree from `index.html` into a new `layout-manager.js` module. After this task, floating mode still works end-to-end; the only visible difference is where the DOM comes from.

**Files:**
- Create: `app/layout-manager.js`
- Modify: `app/main.js`
- Modify: `app/index.html`

- [ ] **Step 1: Create `app/layout-manager.js` with `buildLayout()` for floating mode**

```js
/**
 * layout-manager.js — builds the outer UI chrome.
 *
 * Exports one function, called once from main.js before ChatUI is constructed.
 * Returns mount refs that ChatUI and MapManager consume:
 *
 *   {
 *     chatMount: { container, messages, input, send, mic, header, footer, footerRight },
 *     menuMountId: string   // DOM id where MapManager.generateMenu() should mount
 *   }
 *
 * Two modes, chosen by appConfig.sidebar?.enabled:
 *   - Floating (default): builds the translucent #chat-container on <body>.
 *   - Sidebar:   builds a full-height right-side panel, adds body.sidebar-mode,
 *                houses both the layer menu and the chat.
 *
 * Only floating mode is implemented in Task 1. Sidebar mode comes in Task 5.
 */

export function buildLayout(appConfig) {
    const title = appConfig.sidebar?.title || 'Data Assistant';

    if (appConfig.sidebar?.enabled) {
        // Sidebar mode stub — implemented in Task 5.
        return buildSidebarLayout(appConfig, title);
    }
    return buildFloatingLayout(appConfig, title);
}

/* ----- Floating mode ------------------------------------------------------ */

function buildFloatingLayout(_appConfig, title) {
    const container = el('div', { id: 'chat-container' });

    const header = el('div', { id: 'chat-header' });
    const h3 = el('h3');
    h3.textContent = title;
    const toggle = el('button', { id: 'chat-toggle', title: 'Toggle chat' });
    toggle.textContent = '−';
    header.append(h3, toggle);

    const messages = el('div', { id: 'chat-messages' });

    const inputContainer = el('div', { id: 'chat-input-container' });
    const input = el('input', {
        id: 'chat-input',
        type: 'text',
        placeholder: 'Ask about the data…',
        autocomplete: 'off',
    });
    const mic = el('button', {
        id: 'chat-mic',
        title: 'Hold to record voice input',
    });
    mic.hidden = true;
    mic.textContent = '🎤';
    const send = el('button', { id: 'chat-send' });
    send.textContent = 'Send';
    inputContainer.append(input, mic, send);

    // Footer with left + right zones built upfront (no later restructuring).
    const footer = el('div', { id: 'chat-footer' });
    const footerRight = el('div', { id: 'chat-footer-right' });
    const modelSelector = el('select', {
        id: 'model-selector',
        title: 'Select model',
    });
    footerRight.append(modelSelector);
    footer.append(footerRight);

    container.append(header, messages, inputContainer, footer);
    document.body.appendChild(container);

    return {
        chatMount: { container, messages, input, send, mic, header, footer, footerRight },
        menuMountId: 'menu',
    };
}

/* ----- Sidebar mode (stub — Task 5 fills this in) ------------------------ */

function buildSidebarLayout(appConfig, title) {
    // Placeholder so calls with sidebar.enabled don't throw before Task 5.
    // Falls back to floating for now.
    console.warn('[layout-manager] sidebar mode not yet implemented — falling back to floating');
    return buildFloatingLayout(appConfig, title);
}

/* ----- Small DOM helper -------------------------------------------------- */

function el(tag, attrs = {}) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v != null) node.setAttribute(k, v);
    }
    return node;
}
```

- [ ] **Step 2: Wire `buildLayout` into `main.js`**

Add the import near the top of `app/main.js`:

```js
import { buildLayout } from './layout-manager.js';
```

Inside `main()`, **immediately after** `console.log('[main] Config loaded');` and **before** the `DatasetCatalog` step, build the layout:

```js
    /* ── 1b. Build UI chrome (layout-manager owns floating vs sidebar) ─── */
    const layoutRefs = buildLayout(appConfig);
```

Replace the existing `mapManager.generateMenu('menu');` call with:

```js
    mapManager.generateMenu(layoutRefs.menuMountId);
```

Replace the existing `const ui = new ChatUI(agent, appConfig);` call with (no constructor signature change yet — Task 2 adds `mount`):

```js
    const ui = new ChatUI(agent, appConfig);
    // layoutRefs.chatMount is already wired into the DOM by buildLayout();
    // ChatUI still uses getElementById() at this point (Task 2 switches to refs).
```

- [ ] **Step 3: Remove `#chat-container` block from library `index.html`**

In `app/index.html`, delete lines 53–68 (the `<!-- Chat interface -->` comment and the full `<div id="chat-container">…</div>` block). The file should look like:

```html
<body>
    <!-- Map -->
    <div id="map"></div>

    <!-- Layer controls — generated by MapManager.generateMenu() -->
    <div id="menu"></div>

    <!-- App bootstrap -->
    <script type="module" src="main.js"></script>
</body>
```

- [ ] **Step 4: Manually verify floating mode still works**

Run:

```bash
cd app && python -m http.server 8000
```

Open `http://localhost:8000` in a browser. Verify:
- Chat panel appears in the bottom-right corner with the same visual styling as before.
- Title reads "Data Assistant".
- Typing a message → agent responds → tool call blocks render. (Needs a local `config.json` with a valid LLM key; skip the LLM check if not available, but the DOM must appear correctly.)
- `#chat-header`, `#chat-toggle`, `#chat-messages`, `#chat-input`, `#chat-mic`, `#chat-send`, `#chat-footer`, `#chat-footer-right`, `#model-selector` all exist in the DOM (DevTools).
- Footer already contains `#chat-footer-right` wrapping `#model-selector` (upfront, no restructuring needed later).

- [ ] **Step 5: Commit**

```bash
git add app/layout-manager.js app/main.js app/index.html
git commit -m "refactor: extract floating-mode DOM construction to layout-manager

The chat DOM now lives in app/layout-manager.js rather than index.html,
paving the way for an alternative sidebar shell. Floating mode is
functionally unchanged; footer zones are also built upfront so the
runtime restructureFooter() step becomes unnecessary in a later task.

Part of #127 (sidebar half)."
```

---

## Task 2: Make `ChatUI` mount-agnostic

**Goal:** Swap every `document.getElementById()` lookup for chrome elements inside `chat-ui.js` with refs from a `mount` object passed to the constructor. Delete `restructureFooter()` (no longer needed — footer zones are built upfront). `initResize()` and `initLinks()` stay in this task; they are handled in Tasks 3 and 4.

**Files:**
- Modify: `app/chat-ui.js`
- Modify: `app/main.js`

- [ ] **Step 1: Change the `ChatUI` constructor signature and DOM ref wiring**

In `app/chat-ui.js`, replace the constructor (lines 8–35) with:

```js
export class ChatUI {
    /**
     * @param {import('./agent.js').Agent} agent
     * @param {Object} config  - app config (for model list)
     * @param {Object} mount   - DOM refs from layout-manager.buildLayout()
     *   {
     *     container, messages, input, send, mic, header, footer, footerRight,
     *   }
     */
    constructor(agent, config, mount) {
        this.agent = agent;
        this.config = config;
        this.busy = false;

        // Cache DOM refs from layout-manager (no getElementById here).
        this.container = mount.container;
        this.messagesEl = mount.messages;
        this.inputEl = mount.input;
        this.sendBtn = mount.send;
        this.micBtn = mount.mic;
        this.toggleBtn = mount.container.querySelector('#chat-toggle');  // floating-mode only
        this.headerEl = mount.header;
        this.footerEl = mount.footer;
        this.footerRightEl = mount.footerRight;
        this.modelSelector = mount.footerRight.querySelector('#model-selector');

        // Voice input state. The voice + transcriber modules are loaded
        // lazily via dynamic import() — only when `config.transcription_model`
        // is set. Apps without voice pay zero bytes for audio code.
        this.voice = null;
        this.transcriber = null;
        this.recording = false;

        this.init();
    }
```

- [ ] **Step 2: Update `init()` to stop calling `restructureFooter()`**

In `app/chat-ui.js`, delete the line `this.restructureFooter();` from `init()` (around line 68). The comment `// Restructure footer into left + right zones before adding buttons` above it can also go.

- [ ] **Step 3: Delete the `restructureFooter()` method entirely**

Delete the `restructureFooter` method block (roughly lines 244–256, between the "Footer restructuring" comment header and the next method).

- [ ] **Step 4: Replace `getElementById` calls for chrome elements with mount refs**

Still in `app/chat-ui.js`:

- In `initLinks()`, replace:
  ```js
  const header = document.getElementById('chat-header');
  const toggleBtn = document.getElementById('chat-toggle');
  ```
  with:
  ```js
  const header = this.headerEl;
  const toggleBtn = this.toggleBtn;
  ```

  And replace:
  ```js
  const footer = document.getElementById('chat-footer');
  ```
  with:
  ```js
  const footer = this.footerEl;
  ```
  (This appears inside the `if (links.carbon)` branch.)

- In `initSettingsUI()`, replace:
  ```js
  const footer = document.getElementById('chat-footer-right');
  ```
  with:
  ```js
  const footer = this.footerRightEl;
  ```

- In `initAutoApproveToggle()`, replace:
  ```js
  const footer = document.getElementById('chat-footer-right');
  ```
  with:
  ```js
  const footer = this.footerRightEl;
  ```

Leave `document.getElementById('thinking-indicator')`, `document.getElementById('tool-executing-indicator')`, `document.getElementById('api-settings-panel')`, and `document.getElementById('chat-messages')` in the boot error handler at the bottom of `main.js` **untouched** — these reference dynamically-created or persistent IDs, not layout chrome.

- [ ] **Step 5: Pass the mount object from `main.js` to `ChatUI`**

In `app/main.js`, update the `ChatUI` construction:

```js
    const ui = new ChatUI(agent, appConfig, layoutRefs.chatMount);
```

- [ ] **Step 6: Manually verify floating mode still works**

Run `cd app && python -m http.server 8000` and open the app. Verify:
- Panel layout looks identical to before.
- GitHub / About / Carbon links (if configured) appear in the correct places (header for github/docs, footer for carbon) — unchanged from before Task 2.
- Model selector, auto-approve button, and settings panel (if in user-provided-key mode) all function.
- Collapse toggle (`−`) works.
- `document.getElementById('chat-header')` and similar calls are gone from `chat-ui.js`:
  ```bash
  grep -n "document.getElementById('chat-" app/chat-ui.js
  ```
  Expected: no matches for `'chat-header'`, `'chat-footer'`, `'chat-footer-right'`.

- [ ] **Step 7: Commit**

```bash
git add app/chat-ui.js app/main.js
git commit -m "refactor: ChatUI accepts mount object instead of querying IDs

ChatUI no longer knows about specific DOM IDs for its outer chrome —
it consumes refs from a mount object provided by layout-manager. This
lets the same ChatUI instance render correctly inside either the
floating panel or a future sidebar shell. Drops the now-unnecessary
restructureFooter() method since layout-manager builds the split
footer upfront.

Part of #127 (sidebar half)."
```

---

## Task 3: Move `initResize()` from `ChatUI` to `layout-manager.js`

**Goal:** Relocate the floating-mode corner-drag resize logic into `layout-manager.js` so `ChatUI` no longer owns any layout behavior. The behavior (drag top-left corner to resize width + max-height, 280px / 200px minimum) is identical after the move.

**Files:**
- Modify: `app/layout-manager.js`
- Modify: `app/chat-ui.js`

- [ ] **Step 1: Add `initFloatingResize()` to `layout-manager.js`**

In `app/layout-manager.js`, inside `buildFloatingLayout()`, **just before** the `return { … }` statement, call a new helper:

```js
    initFloatingResize(container);
```

Add the function at the bottom of the file, above `el()`:

```js
/* ----- Floating mode resize (drag top-left corner) ----------------------- */

function initFloatingResize(container) {
    const handle = document.createElement('div');
    handle.className = 'resize-handle';
    container.prepend(handle);

    let startX, startY, startW, startH;

    const onMove = (e) => {
        const dx = startX - e.clientX;   // positive = dragging left → wider
        const dy = startY - e.clientY;   // positive = dragging up   → taller
        const maxW = window.innerWidth - 40;
        const maxH = window.innerHeight - 100;
        container.style.width = Math.min(maxW, Math.max(280, startW + dx)) + 'px';
        container.style.maxHeight = Math.min(maxH, Math.max(200, startH + dy)) + 'px';
    };

    const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.userSelect = '';
    };

    handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        startX = e.clientX;
        startY = e.clientY;
        startW = container.offsetWidth;
        startH = container.offsetHeight;
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}
```

- [ ] **Step 2: Remove `initResize()` from `ChatUI`**

In `app/chat-ui.js`:

- Delete the call `this.initResize();` inside `init()` (just above the `initLinks()` call).
- Delete the entire `initResize()` method block (roughly lines 461–493). The comment-divider line above it (`/* ------------------------------------------------------------------ */`) can stay or go; pick whichever keeps the file tidy.

- [ ] **Step 3: Manually verify resize still works in floating mode**

Run `cd app && python -m http.server 8000`. Verify:
- A subtle handle in the top-left corner of `#chat-container` is visible on hover (same `.resize-handle` CSS as before).
- Click-and-drag from the top-left corner resizes both width and max-height.
- Minimum width clamps at 280px; max width at `window.innerWidth - 40`.
- Minimum height clamps at 200px; max at `window.innerHeight - 100`.
- `initResize` no longer appears in `chat-ui.js`:
  ```bash
  grep -n "initResize" app/chat-ui.js
  ```
  Expected: no matches.

- [ ] **Step 4: Commit**

```bash
git add app/layout-manager.js app/chat-ui.js
git commit -m "refactor: move floating-mode resize from ChatUI to layout-manager

Layout behavior belongs to layout-manager; ChatUI should own chat
mechanics only. Behavior is unchanged — same corner-drag handle,
same bounds. Prepares layout-manager to own the sidebar-mode
edge-drag handle too.

Part of #127 (sidebar half)."
```

---

## Task 4: Footer-links consolidation — all three links in footer-left

**Goal:** Move the `github` and `docs` links from the header into the footer-left zone, alongside the existing `carbon` link. The header becomes link-free (only the title + collapse toggle). This is a mode-agnostic UX tweak that lands with the sidebar work because the header-less header is consistent between floating and sidebar.

**Files:**
- Modify: `app/chat-ui.js`

- [ ] **Step 1: Rewrite `initLinks()` in `chat-ui.js`**

In `app/chat-ui.js`, replace the entire `initLinks()` method (roughly lines 262–316) with:

```js
    initLinks() {
        const links = this.config.links;
        if (!links) return;

        // All links live in the footer-left zone in both floating and sidebar
        // modes. The header is kept link-free.
        const footer = this.footerEl;
        if (!footer) return;

        // Reverse append order: we prepend each link to the footer so that the
        // final left-to-right ordering is docs | github | carbon.
        // (prepend reverses insertion order — insert carbon first, then github,
        //  then docs.)

        if (links.carbon) {
            const a = document.createElement('a');
            a.href = 'https://carbon-api.nrp-nautilus.io/';
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.className = 'footer-link carbon-link';
            a.title = 'Carbon dashboard — energy use for this deployment';
            a.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M17 8C8 10 5.9 16.17 3.82 21.34L5.71 22l1-2.3A4.49 4.49 0 008 20C19 20 22 3 22 3c-1 2-8 5.5-8.5 11.5-2.05-1.05-3.72-3.07-3.72-5.5 0-.67.19-1.3.52-1.83A4.89 4.89 0 0017 8z"/></svg>`;
            footer.prepend(a);
        }

        if (links.github) {
            const a = document.createElement('a');
            a.href = links.github;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.className = 'footer-link github-link';
            a.title = 'Source code';
            a.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;
            footer.prepend(a);
        }

        if (links.docs) {
            const a = document.createElement('a');
            a.href = links.docs;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.className = 'footer-link docs-link';
            a.textContent = 'About';
            a.title = 'Documentation';
            footer.prepend(a);
        }
    }
```

- [ ] **Step 2: Update `app/chat.css` — add `.footer-link` styling for the text/icon links**

Open `app/chat.css` and locate the existing `.header-links` + `.header-link` rules (search for `.header-links`). Add (or adjust) sibling rules so that `.footer-link` picks up consistent styling in its new home. A minimal addition that matches the current `.header-link` visual weight:

```css
/* Footer links (github, docs, carbon) live in #chat-footer's left zone. */
#chat-footer .footer-link {
    display: inline-flex;
    align-items: center;
    padding: 2px 6px;
    margin-right: 4px;
    color: rgba(255, 255, 255, 0.75);
    text-decoration: none;
    font-size: 11px;
    border-radius: 3px;
    transition: color 120ms ease, background 120ms ease;
}

#chat-footer .footer-link:hover {
    color: rgba(255, 255, 255, 1);
    background: rgba(255, 255, 255, 0.08);
}

#chat-footer .footer-link svg {
    display: block;
}
```

If `.carbon-link` already had an explicit style rule in `chat.css`, leave it as-is — the new `.footer-link` rules complement (they style the newly-relocated github and docs links). Verify by inspecting: the three links should share visual weight in the footer.

- [ ] **Step 3: Manually verify the footer looks right**

Start a local server with a `layers-input.json` that has a `"links"` block containing `docs`, `github`, and `carbon` (copy from an existing downstream app if needed, or hand-edit to test). Verify:
- All three links appear in the footer's left zone in the order: **docs (About) | github | carbon**.
- The header contains only the title `<h3>` and the `−` toggle button.
- Links still open in a new tab with `target="_blank"`.
- Styling is consistent with existing carbon-link aesthetic.

- [ ] **Step 4: Commit**

```bash
git add app/chat-ui.js app/chat.css
git commit -m "feat: consolidate all chat links into footer-left zone

Previously the github + docs links went to the chat header and only
carbon sat in the footer. The header is now kept link-free, giving a
consistent layout in both floating and sidebar shells (sidebar header
also carries no links). Applies in both modes.

Part of #127 (sidebar half)."
```

---

## Task 5: Sidebar-mode DOM scaffold in `layout-manager.js`

**Goal:** Implement `buildSidebarLayout()` — a full-height right-side panel with header, layers pane, chat region, and footer. Add `body.sidebar-mode` class. Config-gated: only triggers when `appConfig.sidebar?.enabled === true`. No CSS yet (that's Task 6); the DOM should simply appear (unstyled) when the flag is flipped.

**Files:**
- Modify: `app/layout-manager.js`

- [ ] **Step 1: Replace the `buildSidebarLayout()` stub with a real implementation**

In `app/layout-manager.js`, replace the placeholder `buildSidebarLayout()` function with:

```js
/* ----- Sidebar mode ------------------------------------------------------ */

function buildSidebarLayout(appConfig, title) {
    document.body.classList.add('sidebar-mode');

    // Apply initial --sidebar-width from config (localStorage override
    // is applied in Task 7 when resize persistence is added).
    const defaultWidth = Number(appConfig.sidebar?.default_width) || 420;
    document.documentElement.style.setProperty('--sidebar-width', defaultWidth + 'px');

    const sidebar = el('aside', { id: 'sidebar' });

    // Resize handle (wired in Task 7).
    const resizeHandle = el('div', { class: 'sidebar-resize-handle' });

    // Header
    const header = el('div', { id: 'sidebar-header' });
    const h3 = el('h3');
    h3.textContent = title;
    const hideBtn = el('button', {
        id: 'sidebar-hide',
        title: 'Hide sidebar',
    });
    hideBtn.textContent = '→';
    header.append(h3, hideBtn);

    // Layers pane — MapManager.generateMenu() will mount inside this element.
    const layersPane = el('div', { id: 'sidebar-layers-pane' });

    // Chat message list
    const messages = el('div', { id: 'chat-messages' });

    // Input row
    const inputContainer = el('div', { id: 'chat-input-container' });
    const input = el('input', {
        id: 'chat-input',
        type: 'text',
        placeholder: 'Ask about the data…',
        autocomplete: 'off',
    });
    const mic = el('button', {
        id: 'chat-mic',
        title: 'Hold to record voice input',
    });
    mic.hidden = true;
    mic.textContent = '🎤';
    const send = el('button', { id: 'chat-send' });
    send.textContent = 'Send';
    inputContainer.append(input, mic, send);

    // Footer with left + right zones — same structure as floating mode so
    // ChatUI code is layout-agnostic.
    const footer = el('div', { id: 'sidebar-footer' });
    const footerRight = el('div', { id: 'chat-footer-right' });
    const modelSelector = el('select', {
        id: 'model-selector',
        title: 'Select model',
    });
    footerRight.append(modelSelector);
    footer.append(footerRight);

    sidebar.append(resizeHandle, header, layersPane, messages, inputContainer, footer);
    document.body.appendChild(sidebar);

    // Floating "show" button pinned to the top-right of the map,
    // visible only when body.sidebar-mode.sidebar-collapsed. Click restores.
    const showBtn = el('button', {
        id: 'sidebar-show-btn',
        title: 'Show sidebar',
    });
    showBtn.textContent = '←';
    document.body.appendChild(showBtn);

    return {
        chatMount: {
            container: sidebar,
            messages,
            input,
            send,
            mic,
            header,
            footer,
            footerRight,
        },
        menuMountId: 'sidebar-layers-pane',
    };
}
```

Note: `ChatUI.init()` sets up `this.toggleBtn = mount.container.querySelector('#chat-toggle')`, which will correctly resolve to `null` in sidebar mode (no collapse toggle inside the chat — the sidebar header's `#sidebar-hide` owns collapse, wired in Task 8). The existing `this.toggleBtn?.addEventListener(…)` is already optional-chained and handles this.

- [ ] **Step 2: Manually verify sidebar DOM appears when enabled**

Edit `app/layers-input.json` locally (do **not** commit this change) to add:

```json
"sidebar": {
    "enabled": true,
    "default_width": 420,
    "title": "Data Assistant"
},
```

Run `cd app && python -m http.server 8000`. Verify in DevTools:
- `<body class="sidebar-mode">` is present.
- `#sidebar`, `#sidebar-header`, `#sidebar-layers-pane`, `#chat-messages`, `#chat-input-container`, `#sidebar-footer` all exist.
- `#sidebar-show-btn` exists but is probably wildly mis-positioned (no CSS yet — that's Task 6).
- `document.documentElement.style.getPropertyValue('--sidebar-width')` equals `420px`.
- The chat still functions (type a message, get a response), though visually broken.

Revert the `layers-input.json` edit — leave the committed state at floating default. (You'll flip it back on locally in subsequent tasks to test.)

- [ ] **Step 3: Commit**

```bash
git add app/layout-manager.js
git commit -m "feat: add sidebar-mode DOM scaffold to layout-manager

When sidebar.enabled is true in layers-input.json, build a
full-height right-side panel with header, layers pane, chat, and
footer; add body.sidebar-mode class and initialize --sidebar-width.
Unstyled until Task 6 adds sidebar.css.

Part of #127 (sidebar half)."
```

---

## Task 6: Create `app/sidebar.css` and wire it into `index.html`

**Goal:** Add the sidebar's visual styling — push-layout (`#map { right: var(--sidebar-width, 0) }`), resize-handle aesthetics, header/footer, collapse transition, narrow-viewport fallback. All selectors scoped to `body.sidebar-mode …` or to IDs that only exist in sidebar mode, so the stylesheet can load unconditionally.

**Files:**
- Create: `app/sidebar.css`
- Modify: `app/index.html`

- [ ] **Step 1: Create `app/sidebar.css`**

```css
/* sidebar.css — layout + chrome for the opt-in full-height sidebar.
 *
 * Safe to load unconditionally: every rule is either scoped to
 * body.sidebar-mode, or targets IDs that only exist in sidebar mode.
 */

/* ----- Push-layout: map makes room for the sidebar ---------------------- */

body.sidebar-mode #map {
    right: var(--sidebar-width, 0);
    width: auto;
}

/* Keep the original floating #menu div out of the way in sidebar mode —
 * the layer menu renders inside #sidebar-layers-pane instead. */
body.sidebar-mode #menu {
    display: none;
}

/* ----- Sidebar container ------------------------------------------------- */

body.sidebar-mode #sidebar {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: var(--sidebar-width, 420px);
    background: #1e1e24;
    color: #e5e7eb;
    display: flex;
    flex-direction: column;
    z-index: 10;
    box-shadow: -2px 0 6px rgba(0, 0, 0, 0.2);
    transition: transform 200ms ease;
    /* Sidebar chat uses solid background — override any glass blur coming
     * from chat.css that assumes a translucent floating container. */
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
}

/* ----- Resize handle on the left edge ----------------------------------- */

body.sidebar-mode .sidebar-resize-handle {
    position: absolute;
    top: 0;
    left: 0;
    bottom: 0;
    width: 6px;
    cursor: col-resize;
    background: transparent;
    border-left: 1px solid rgba(255, 255, 255, 0.08);
    transition: border-color 120ms ease, background 120ms ease;
    z-index: 2;
}

body.sidebar-mode .sidebar-resize-handle:hover {
    border-left-color: rgba(120, 170, 255, 0.8);
    background: rgba(120, 170, 255, 0.08);
}

/* ----- Header ------------------------------------------------------------ */

body.sidebar-mode #sidebar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    flex: 0 0 auto;
}

body.sidebar-mode #sidebar-header h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    letter-spacing: 0.2px;
}

body.sidebar-mode #sidebar-hide {
    background: transparent;
    border: none;
    color: inherit;
    font-size: 16px;
    cursor: pointer;
    padding: 2px 8px;
    border-radius: 3px;
}

body.sidebar-mode #sidebar-hide:hover {
    background: rgba(255, 255, 255, 0.08);
}

/* ----- Layers pane ------------------------------------------------------- */

body.sidebar-mode #sidebar-layers-pane {
    flex: 0 0 auto;
    max-height: 40%;
    overflow-y: auto;
    padding: 8px 12px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

/* ----- Chat region — override a few chat.css rules that assume a
 *       translucent floating panel. ------------------------------------- */

body.sidebar-mode #chat-messages {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 10px 12px;
}

body.sidebar-mode #chat-input-container {
    flex: 0 0 auto;
    display: flex;
    gap: 6px;
    padding: 8px 12px;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
}

body.sidebar-mode #chat-input-container #chat-input {
    flex: 1;
}

/* ----- Footer ------------------------------------------------------------ */

body.sidebar-mode #sidebar-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px 8px;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    font-size: 11px;
    flex: 0 0 auto;
}

body.sidebar-mode #sidebar-footer #chat-footer-right {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
}

body.sidebar-mode #sidebar-footer .footer-link {
    display: inline-flex;
    align-items: center;
    padding: 2px 6px;
    margin-right: 4px;
    color: rgba(255, 255, 255, 0.75);
    text-decoration: none;
    border-radius: 3px;
}

body.sidebar-mode #sidebar-footer .footer-link:hover {
    color: rgba(255, 255, 255, 1);
    background: rgba(255, 255, 255, 0.08);
}

/* ----- Collapse / show toggle ------------------------------------------- */

body.sidebar-mode.sidebar-collapsed {
    --sidebar-width: 0px;
}

body.sidebar-mode.sidebar-collapsed #sidebar {
    transform: translateX(100%);
}

#sidebar-show-btn {
    position: fixed;
    top: 10px;
    right: 10px;
    display: none;  /* shown only while collapsed */
    background: rgba(255, 255, 255, 0.85);
    -webkit-backdrop-filter: blur(8px);
    backdrop-filter: blur(8px);
    border: 1px solid rgba(0, 0, 0, 0.1);
    border-radius: 4px;
    padding: 4px 10px;
    font-size: 14px;
    cursor: pointer;
    z-index: 12;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
}

body.sidebar-mode.sidebar-collapsed #sidebar-show-btn {
    display: block;
}

/* ----- Z-index adjustments for floating map overlays in narrow map ----- */

body.sidebar-mode #legend,
body.sidebar-mode #h3-toggle,
body.sidebar-mode #h3-res-badge {
    z-index: 5;
}

/* ----- Narrow-viewport fallback: overlay instead of push --------------- */

@media (max-width: 700px) {
    body.sidebar-mode #map {
        right: 0;
        width: 100%;
    }
    body.sidebar-mode #sidebar {
        --sidebar-width: min(400px, 90vw);
        width: var(--sidebar-width);
        box-shadow: -4px 0 10px rgba(0, 0, 0, 0.35);
    }
    body.sidebar-mode .sidebar-resize-handle {
        /* Drag-resize disabled on narrow viewports. */
        pointer-events: none;
    }
}
```

- [ ] **Step 2: Add the `<link>` tag to `app/index.html`**

In `app/index.html`, inside `<head>`, directly after the existing `<link rel="stylesheet" href="chat.css">` line, add:

```html
    <link rel="stylesheet" href="sidebar.css">
```

- [ ] **Step 3: Manually verify styling in both modes**

First, verify **floating mode** is unchanged:
- Leave `layers-input.json` with no `sidebar` block (or `enabled: false`).
- Run `cd app && python -m http.server 8000`. The app should look identical to before Task 6. `sidebar.css` loads but nothing matches (since `body.sidebar-mode` is absent).

Then verify **sidebar mode** styles render:
- Locally add `"sidebar": { "enabled": true, "default_width": 420, "title": "Data Assistant" }` to `layers-input.json`.
- Reload. Verify:
  - A dark panel occupies the right 420px of the viewport, full-height.
  - The map reflows to fill the remaining width (`#map { right: var(--sidebar-width) }`).
  - Sidebar header shows the title and a `→` hide button (not yet wired — Task 8).
  - Layers pane slot exists (empty — mount wiring comes in Task 9).
  - Chat messages scroll inside the sidebar; input + send sit at the bottom.
  - Footer shows the model selector right-aligned.
  - Floating `#menu` is hidden (visible only in floating mode).
  - Resize handle on the left edge shows a subtle border on hover (cursor becomes `col-resize`). Dragging doesn't do anything yet — Task 7.

Revert the `layers-input.json` edit once verified.

- [ ] **Step 4: Commit**

```bash
git add app/sidebar.css app/index.html
git commit -m "feat: sidebar.css — push-layout, chrome, narrow-viewport fallback

All rules are scoped to body.sidebar-mode or to sidebar-only IDs, so
the stylesheet loads unconditionally without affecting floating mode.
Push layout via CSS variable --sidebar-width; map reflows via
#map { right: var(--sidebar-width) }. Includes a @media (max-width:
700px) fallback that switches to overlay mode.

Part of #127 (sidebar half)."
```

---

## Task 7: Wire sidebar resize — `--sidebar-width`, `map.resize()`, localStorage

**Goal:** Dragging the left-edge handle updates the `--sidebar-width` CSS variable, which reflows the map; MapLibre's `map.resize()` fires on a `requestAnimationFrame` loop during drag and one final time on drag-end. Width is clamped to `[280, 0.6 * window.innerWidth]`, re-clamped on window resize. Drag-end persists width to `localStorage['geo-agent-sidebar-width']`; boot reads it and overrides `config.sidebar.default_width` if still within bounds.

**Files:**
- Modify: `app/layout-manager.js`
- Modify: `app/main.js`

- [ ] **Step 1: Add a module-level `sidebarResizeHooks` object to `layout-manager.js`**

At the top of `app/layout-manager.js`, below the file-level docstring, add:

```js
// State exposed to main.js so it can wire map.resize() into the drag loop.
export const sidebarHooks = {
    /** @type {(() => void) | null} — called on every rAF tick during drag */
    onResizeTick: null,
    /** @type {(() => void) | null} — called once on drag-end / collapse transitionend */
    onResizeEnd: null,
};
```

Export it alongside `buildLayout` (it's already `export const`).

- [ ] **Step 2: Add `initSidebarResize()` and the width clamp / localStorage logic**

In `app/layout-manager.js`, inside `buildSidebarLayout()`, just before the `return { … }` statement, call the new helper:

```js
    initSidebarResize(resizeHandle, defaultWidth);
```

Add these two helpers at the bottom of the file, above `el()`:

```js
/* ----- Sidebar resize: edge drag + localStorage + rAF map reflow -------- */

const SIDEBAR_WIDTH_KEY = 'geo-agent-sidebar-width';

function sidebarWidthBounds() {
    const min = 280;
    const max = Math.max(min, Math.floor(0.6 * window.innerWidth));
    return { min, max };
}

function clampSidebarWidth(w) {
    const { min, max } = sidebarWidthBounds();
    return Math.min(max, Math.max(min, w));
}

function applySidebarWidth(w) {
    document.documentElement.style.setProperty('--sidebar-width', w + 'px');
}

function initSidebarResize(handle, defaultWidth) {
    // Boot: localStorage overrides config.default_width if within bounds.
    const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    const initial = clampSidebarWidth(Number.isFinite(stored) && stored > 0 ? stored : defaultWidth);
    applySidebarWidth(initial);

    // Re-clamp on window resize so sidebar never exceeds 60vw.
    window.addEventListener('resize', () => {
        const cur = parseFloat(
            getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'),
        );
        if (Number.isFinite(cur)) {
            applySidebarWidth(clampSidebarWidth(cur));
            sidebarHooks.onResizeEnd?.();
        }
    });

    // Drag behavior.
    let dragging = false;
    let startX = 0;
    let startW = 0;
    let rafPending = false;
    let pendingW = 0;

    const onMove = (e) => {
        if (!dragging) return;
        // Left-edge drag: pulling LEFT (clientX decreases) makes the sidebar wider.
        const dx = startX - e.clientX;
        pendingW = clampSidebarWidth(startW + dx);
        if (!rafPending) {
            rafPending = true;
            requestAnimationFrame(() => {
                rafPending = false;
                applySidebarWidth(pendingW);
                sidebarHooks.onResizeTick?.();
            });
        }
    };

    const onUp = () => {
        if (!dragging) return;
        dragging = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.userSelect = '';

        // Persist final width and do one more reflow after layout settles.
        const { min, max } = sidebarWidthBounds();
        const finalW = clampSidebarWidth(pendingW);
        applySidebarWidth(finalW);
        if (finalW >= min && finalW <= max) {
            localStorage.setItem(SIDEBAR_WIDTH_KEY, String(finalW));
        }
        sidebarHooks.onResizeEnd?.();
    };

    handle.addEventListener('mousedown', (e) => {
        // Respect the narrow-viewport CSS that sets pointer-events: none.
        if (getComputedStyle(handle).pointerEvents === 'none') return;
        e.preventDefault();
        dragging = true;
        startX = e.clientX;
        startW = parseFloat(
            getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'),
        ) || 420;
        pendingW = startW;
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}
```

- [ ] **Step 3: Wire `map.resize()` into `sidebarHooks` from `main.js`**

In `app/main.js`, update the `buildLayout` import:

```js
import { buildLayout, sidebarHooks } from './layout-manager.js';
```

Immediately after `await mapManager.ready;` (near line 67), wire the hooks:

```js
    // Sidebar resize: reflow the MapLibre canvas during drag (rAF-gated by
    // layout-manager) and one final time on drag-end / window-resize.
    sidebarHooks.onResizeTick = () => mapManager.map.resize();
    sidebarHooks.onResizeEnd = () => mapManager.map.resize();
```

Note: in floating mode, `sidebarHooks.onResizeTick` stays null-assigned here, but nothing calls it (floating-mode drag only mutates `container.style.*`, not `--sidebar-width`). Harmless.

- [ ] **Step 4: Manually verify resize in sidebar mode**

Locally flip `layers-input.json` to `sidebar.enabled: true`. Run `cd app && python -m http.server 8000`. Verify:
- Dragging the left edge resizes fluidly; the map narrows smoothly with no stutter on a modern desktop.
- Width clamps at 280px minimum and `0.6 * window.innerWidth` maximum.
- Shrink the browser window → sidebar re-clamps to stay under 60vw.
- Reload → width is restored from `localStorage['geo-agent-sidebar-width']`.
- DevTools:
  ```js
  localStorage.getItem('geo-agent-sidebar-width')  // returns the last-dragged width
  ```
- Then clear it:
  ```js
  localStorage.removeItem('geo-agent-sidebar-width')
  ```
  Reload → width falls back to `config.sidebar.default_width` (420 by default).
- MapLibre renders without visible artifacts during drag (tile seams/gaps are fine; a frozen canvas would be a bug).

Revert the local `layers-input.json` edit.

- [ ] **Step 5: Commit**

```bash
git add app/layout-manager.js app/main.js
git commit -m "feat: sidebar resize — --sidebar-width, map.resize(), localStorage

Dragging the left-edge handle updates the --sidebar-width CSS variable
and fires map.resize() on a rAF loop so the MapLibre canvas reflows in
lockstep. Width is clamped to [280, 60vw] and re-clamped on window
resize. Drag-end persists width to localStorage; boot restores it if
still within bounds. Exposes sidebarHooks so main.js can inject the
map reflow without layout-manager importing map state.

Part of #127 (sidebar half)."
```

---

## Task 8: Wire collapse — `#sidebar-hide`, `#sidebar-show-btn`, slide transition

**Goal:** Clicking `#sidebar-hide` toggles `body.sidebar-collapsed`, which CSS translates the sidebar off-screen and pins `--sidebar-width` to 0. A floating `#sidebar-show-btn` on the map restores the sidebar when collapsed. `map.resize()` fires on the sidebar's `transitionend`. Collapsed state is **not** persisted across reloads.

**Files:**
- Modify: `app/layout-manager.js`

- [ ] **Step 1: Add `initSidebarCollapse()` in `layout-manager.js`**

In `app/layout-manager.js`, inside `buildSidebarLayout()`, below the `initSidebarResize(resizeHandle, defaultWidth);` call (added in Task 7), add:

```js
    initSidebarCollapse(sidebar, hideBtn, showBtn);
```

Add the helper at the bottom of the file, above `el()`:

```js
/* ----- Sidebar collapse / show ------------------------------------------ */

function initSidebarCollapse(sidebar, hideBtn, showBtn) {
    const setCollapsed = (collapsed) => {
        document.body.classList.toggle('sidebar-collapsed', collapsed);
    };

    hideBtn.addEventListener('click', () => setCollapsed(true));
    showBtn.addEventListener('click', () => setCollapsed(false));

    // Reflow the map canvas after the slide transition completes in EITHER
    // direction. Using transitionend on the sidebar (not the body) because
    // that's what actually transitions.
    sidebar.addEventListener('transitionend', (e) => {
        if (e.propertyName !== 'transform') return;
        sidebarHooks.onResizeEnd?.();
    });
}
```

- [ ] **Step 2: Manually verify collapse and show**

Locally flip `layers-input.json` to `sidebar.enabled: true`. Run `cd app && python -m http.server 8000`. Verify:
- Clicking `→` (the `#sidebar-hide` button in the sidebar header) slides the sidebar off-screen smoothly (~200ms).
- After the transition ends, the map fills the full viewport (tiles visible under where the sidebar used to be).
- A small `←` button (`#sidebar-show-btn`) appears pinned to the top-right of the map.
- Clicking `←` slides the sidebar back in; `#sidebar-show-btn` disappears.
- During each transition, the map does not stutter or freeze.
- Reload the page — the sidebar comes back, even if it was collapsed before reload (collapsed state is intentionally not persisted).

Revert the local `layers-input.json` edit.

- [ ] **Step 3: Commit**

```bash
git add app/layout-manager.js
git commit -m "feat: sidebar collapse / show with slide transition

#sidebar-hide in the header collapses to body.sidebar-collapsed, which
translates the panel off-screen via CSS; a floating #sidebar-show-btn
pinned to the top-right of the map restores it. Collapsed state is
not persisted across reloads — refresh restores the sidebar, avoiding
a 'my chat vanished!' surprise. map.resize() fires on transitionend.

Part of #127 (sidebar half)."
```

---

## Task 9: Verify layer-menu mount into `#sidebar-layers-pane`

**Goal:** Confirm `MapManager.generateMenu()` already accepts a mount-id argument and renders correctly into `#sidebar-layers-pane` in sidebar mode. The design spec asserts this ("no signature change — generateMenu(mountId) already accepts a mount id"), but `main.js` used the literal `'menu'` before. This task is mostly verification, with a tiny fix if the assertion turns out to be wrong.

**Files:**
- Modify (only if needed): `app/map-manager.js`

- [ ] **Step 1: Confirm `generateMenu` accepts a mount id**

Run:

```bash
grep -n "generateMenu" app/map-manager.js
```

Expected output: a method signature like `generateMenu(containerId)` or `generateMenu(mountId)` that reads the element by that id. If the signature is already parameterized, no edit is needed.

If the signature is hardcoded (e.g., reads `document.getElementById('menu')` directly), add a parameter:

```js
generateMenu(mountId = 'menu') {
    const mount = document.getElementById(mountId);
    if (!mount) {
        console.warn(`[MapManager] generateMenu: no element with id "${mountId}"`);
        return;
    }
    // … existing body, but write into `mount` instead of the hardcoded ref.
}
```

- [ ] **Step 2: Manually verify the layer menu renders in the sidebar**

Locally flip `layers-input.json` to `sidebar.enabled: true`. Run `cd app && python -m http.server 8000`. Verify:
- The layer panel appears inside `#sidebar-layers-pane` (top section of the sidebar, below the header).
- Collection group headings, checkboxes, version `<select>` dropdowns, and basemap toggles all work as in floating mode.
- Toggling a layer checkbox → layer appears on the map.
- The original floating `#menu` div is empty (and hidden by `display: none` in `sidebar.css`).
- In floating mode (flip `enabled` back to `false`), the layer menu still renders into `#menu` as before.

Revert the local `layers-input.json` edit.

- [ ] **Step 3: Commit (only if `map-manager.js` was modified)**

If Step 1 required a code change:

```bash
git add app/map-manager.js
git commit -m "fix: MapManager.generateMenu() accepts a mount id parameter

Layout-manager passes 'menu' in floating mode and 'sidebar-layers-pane'
in sidebar mode. Signature-only change; behavior unchanged when the
default is used.

Part of #127 (sidebar half)."
```

If Step 1 confirmed the signature was already parameterized, skip the commit with a note in the PR description: "Task 9 required no code change — `generateMenu` already accepted a mount id."

---

## Task 10: Update `geo-agent-template` — minimal HTML + commented sidebar example

**Goal:** Sync the downstream-template repo to the new DOM surface. Remove `#chat-container` from its `index.html`, add the `<link>` for `sidebar.css` from jsDelivr, and drop an opt-in `sidebar` example block (commented out) into its `layers-input.json`. The template's committed state defaults to floating mode so current users see no visual change.

**Files:** (in the sibling repo `~/Documents/github/boettiger-lab/geo-agent-template/`)
- Modify: `index.html`
- Modify: `layers-input.json`

- [ ] **Step 1: Remove the `#chat-container` block from `geo-agent-template/index.html`**

Open `~/Documents/github/boettiger-lab/geo-agent-template/index.html`. Locate the `<!-- Chat interface -->` comment and its `<div id="chat-container">…</div>` block (roughly lines 55–68). Delete both the comment and the block. The resulting `<body>` should look like:

```html
<body>
    <!-- Map -->
    <div id="map"></div>

    <!-- Layer controls — generated by MapManager.generateMenu() -->
    <div id="menu"></div>

    <!-- Boot from CDN -->
    <script type="module" src="https://cdn.jsdelivr.net/gh/boettiger-lab/geo-agent@main/app/main.js"></script>
</body>
```

- [ ] **Step 2: Add the `<link>` for `sidebar.css` in the template's `<head>`**

In the same file, directly after the existing `<link rel="stylesheet" href=".../chat.css">` line, add:

```html
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/boettiger-lab/geo-agent@main/app/sidebar.css">
```

- [ ] **Step 3: Add a commented-out `sidebar` example block to `layers-input.json`**

Open `~/Documents/github/boettiger-lab/geo-agent-template/layers-input.json`. JSON doesn't support `//` or `/* */` comments, so the example must live as a disabled, inert key (`_sidebar_example`) that the app ignores. Near the top of the object, after `"catalog": …` and related keys, add:

```json
    "_sidebar_example": {
        "_comment": "Rename this key to 'sidebar' to opt in to the full-height sidebar layout. Default is the floating chat panel.",
        "enabled": true,
        "default_width": 420,
        "title": "Data Assistant"
    },
```

The app only reads `sidebar`, not `_sidebar_example`, so this is a self-documenting, no-op example.

- [ ] **Step 4: Manually verify the template still works**

From the template repo:

```bash
cd ~/Documents/github/boettiger-lab/geo-agent-template
python -m http.server 8001
```

Open `http://localhost:8001` in a browser. Verify:
- App boots; map loads; floating chat panel appears in the bottom-right (default floating mode).
- DevTools: `sidebar.css` loaded from jsDelivr; `#chat-container` exists (built by layout-manager); `#sidebar` does not.

Then test opt-in:
- Rename `_sidebar_example` → `sidebar` in `layers-input.json`.
- Reload. Verify the sidebar appears as full-height right-side panel with layers + chat.
- Rename back to `_sidebar_example` before committing.

> **jsDelivr cache:** once the library PR (Tasks 1–9) merges to `main`, jsDelivr may take a few minutes to serve the updated `main.js` / `chat-ui.js` / `layout-manager.js` / `sidebar.css`. Purge URLs listed in `AGENTS.md` if needed while validating.

- [ ] **Step 5: Commit in the template repo**

```bash
cd ~/Documents/github/boettiger-lab/geo-agent-template
git checkout -b template/sidebar-layout
git add index.html layers-input.json
git commit -m "chore: update template for geo-agent layout-manager refactor

Remove the #chat-container HTML block — layout-manager now builds the
chat DOM in JS (both in floating and sidebar modes). Add a <link> for
the new sidebar.css stylesheet, and include a commented-out 'sidebar'
example block in layers-input.json showing how to opt in.

Default behavior is unchanged: floating chat panel."
git push -u origin template/sidebar-layout
```

Then open the PR via the URL printed in the push output. (Merge the template PR only after the geo-agent library PR has merged, so `@main` references the new files.)

---

## Task 11: Document the sidebar configuration in the guide

**Goal:** Add a "Sidebar layout" subsection to `docs/guide/configuration.md` documenting `sidebar.enabled`, `sidebar.default_width`, `sidebar.title`, and linking to the design spec.

**Files:**
- Modify: `docs/guide/configuration.md`

- [ ] **Step 1: Add the "Sidebar layout" subsection**

Open `docs/guide/configuration.md`. Locate a logical place to insert a new subsection — a good spot is right before the existing "Welcome" / "Links" sections if they exist, or at the end of top-level-fields coverage. Add the following:

````markdown
## Sidebar layout

By default, geo-agent renders a small translucent chat panel floating in the
bottom-right corner of the map. Apps that benefit from more chat real-estate
(e.g., heavy analytical use, long tool-call transcripts, prominent layer menus)
can opt in to a full-height, resizable sidebar via a top-level `sidebar` block
in `layers-input.json`.

```json
"sidebar": {
    "enabled": true,
    "default_width": 420,
    "title": "Data Assistant"
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `false` | Opts in to sidebar mode. Omitting the whole `sidebar` block is equivalent to `false`. |
| `default_width` | number | `420` | Starting width in pixels. The user's last-dragged width (stored in `localStorage`) overrides this on reload, as long as it's within bounds. |
| `title` | string | `"Data Assistant"` | Text shown in the sidebar header (and in the floating panel header too — this key applies to both modes). |

In sidebar mode, the layer-controls menu and the chat share one full-height
right-side panel. The map reflows to fill the remaining width. The sidebar's
left edge is draggable (width clamps to `[280px, 60vw]`), and a header button
collapses it off-screen for an unobstructed map. A floating "show" button on
the map restores the sidebar when collapsed.

Below a viewport width of 700px (tablets, phones), the sidebar automatically
switches to overlay mode: it floats above the map rather than pushing it, and
drag-resize is disabled. It also starts collapsed by default, so mobile users
see the full map first.

The legend and H3/draw buttons remain free-floating overlays on the map in
both modes.

> Design details: see `docs/superpowers/specs/2026-04-15-sidebar-layout-design.md`.
````

- [ ] **Step 2: Verify the VitePress docs build (if a build step is available)**

If the docs site has a local preview command (typically `npm run docs:dev` or similar in the repo root), run it and check that the new subsection renders. If the docs site does not have a build step configured locally, visual inspection of the markdown source is sufficient.

- [ ] **Step 3: Commit**

```bash
git add docs/guide/configuration.md
git commit -m "docs: document sidebar layout configuration

New 'Sidebar layout' subsection in the configuration guide covers the
sidebar.enabled / default_width / title keys, the default behavior, the
resize/collapse UX, and the narrow-viewport fallback. Links to the
design spec.

Part of #127 (sidebar half)."
```

---

## Final verification (before opening the library PR)

Before pushing the `spec/sidebar-layout` branch and opening the geo-agent library PR, run through this comprehensive manual checklist against the dev server.

### Mode-agnostic checks (must pass identically in floating and sidebar)

Flip between `sidebar.enabled: false` and `sidebar.enabled: true` in `layers-input.json`; repeat each check in both modes.

- [ ] User message → agent response cycle works end-to-end.
- [ ] Tool-call approval flow works (propose → approve → results render).
- [ ] Tool blocks render with collapsible `<details>` blocks intact; SQL highlighted.
- [ ] Voice input (if `transcription_model` is configured in local `config.json`): mic button appears, records, transcribes, drops into input.
- [ ] Model selector populates from `llm_models`; switching models takes effect.
- [ ] Auto-approve button toggles on/off; state persists across reload via localStorage.
- [ ] Settings panel (in user-provided-API-key mode): opens, saves key, triggers re-render of model list.
- [ ] Welcome message + example buttons (if `welcome` configured) render and populate the input on click.
- [ ] Footer links (`docs`, `github`, `carbon` — whichever are configured) all appear in the footer-left zone; header is link-free.

### Sidebar-specific checks

(With `sidebar.enabled: true`.)

- [ ] Dragging the left edge resizes fluidly; `#map` narrows in lockstep; MapLibre reflows without frozen tiles or visible artifacts.
- [ ] Width clamps at 280px minimum and `0.6 * window.innerWidth` maximum.
- [ ] Resizing the browser window re-clamps the sidebar below 60vw.
- [ ] Reload preserves the last-dragged width from `localStorage['geo-agent-sidebar-width']`.
- [ ] Clearing localStorage and reloading falls back to `config.sidebar.default_width`.
- [ ] Clicking `→` (sidebar-hide) slides the sidebar off-screen; map fills the viewport; `←` (sidebar-show-btn) appears pinned to top-right of map.
- [ ] Clicking `←` restores the sidebar; `#sidebar-show-btn` disappears.
- [ ] Reload a page that was collapsed → sidebar comes back visible (collapsed state NOT persisted).
- [ ] Resize browser window to < 700px width → sidebar overlays the map (doesn't push); width pinned to `min(400px, 90vw)`; drag-resize disabled.
- [ ] Layer menu renders at the top of the sidebar; all checkboxes / version selectors / basemap toggles work.
- [ ] Legend and H3-toggle buttons remain as floating overlays on the map (z-index correct, not hidden behind sidebar).

### Floating-mode parity

(With `sidebar.enabled: false` or omitted.)

- [ ] Chat panel looks visually indistinguishable from the pre-refactor state — same translucent glass aesthetic, same corner position, same size.
- [ ] Corner-drag resize still works (top-left handle).
- [ ] The only intentional difference is the header → footer link consolidation.

---

## PR and rollout

- [ ] **Push the library branch and open the PR**

From the geo-agent repo root (branch `spec/sidebar-layout`):

```bash
git push -u origin spec/sidebar-layout
```

Open the PR URL printed in the push output. PR description should:
- Link to issue #127.
- Summarize: "Opt-in sidebar layout via `layers-input.json`; floating is still default. ChatUI is mount-agnostic — single source of truth. Plotting (other half of #127) is a follow-up spec."
- Paste the manual-verification checklist above, with checkboxes filled for modes that were verified locally.
- Note: "Template PR (`geo-agent-template#<n>`) is paired — merge library first, then template."

- [ ] **Merge order**

1. Library PR (this work) merges first.
2. Purge jsDelivr cache for the new/changed files:
   ```
   https://purge.jsdelivr.net/gh/boettiger-lab/geo-agent@main/app/main.js
   https://purge.jsdelivr.net/gh/boettiger-lab/geo-agent@main/app/chat-ui.js
   https://purge.jsdelivr.net/gh/boettiger-lab/geo-agent@main/app/layout-manager.js
   https://purge.jsdelivr.net/gh/boettiger-lab/geo-agent@main/app/sidebar.css
   https://purge.jsdelivr.net/gh/boettiger-lab/geo-agent@main/app/index.html
   ```
3. Merge the template PR after the library's `@main` serves the new files (verified in browser DevTools on the deployed template).
4. Validate an `@main`-pinned demo app (flip one to `sidebar.enabled: true` to confirm parity end-to-end).
5. Downstream production apps migrate on `geo-agent-ops`'s schedule — pinned apps stay on their current SHA until their maintainer is ready.

- [ ] **Clean up the spec branch after merge**

```bash
git checkout main
git pull --rebase
git branch -d spec/sidebar-layout
```

---

## Out of scope (follow-up specs / tasks)

- **Plotting / chart rendering** — the other half of issue #127. Separate spec will be written once this layout lands and stabilizes.
- **"Last chart" panel** — the sidebar config block is designed to admit a future `plot_panel: true` key, but no such panel is built here.
- **Layer menu redesign** — at 280px minimum width the menu feels tight; any redesign is a separate effort.
- **Dropping `<div id="menu">` from the downstream HTML entirely** — currently left in place so floating mode has a home for the menu; a later cleanup can remove it from templates if preferred.
