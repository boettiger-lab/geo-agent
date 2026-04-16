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
    toggle.textContent = '\u2212';
    header.append(h3, toggle);

    const messages = el('div', { id: 'chat-messages' });

    const inputContainer = el('div', { id: 'chat-input-container' });
    const input = el('input', {
        id: 'chat-input',
        type: 'text',
        placeholder: 'Ask about the data\u2026',
        autocomplete: 'off',
    });
    const mic = el('button', {
        id: 'chat-mic',
        title: 'Hold to record voice input',
    });
    mic.hidden = true;
    mic.textContent = '\uD83C\uDFA4';
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

    initFloatingResize(container);

    return {
        chatMount: { container, messages, input, send, mic, header, footer, footerRight },
        menuMountId: 'menu',
    };
}

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

/* ----- Small DOM helper -------------------------------------------------- */

function el(tag, attrs = {}) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v != null) node.setAttribute(k, v);
    }
    return node;
}
