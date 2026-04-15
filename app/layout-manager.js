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

    return {
        chatMount: { container, messages, input, send, mic, header, footer, footerRight },
        menuMountId: 'menu',
    };
}

/* ----- Sidebar mode (stub — Task 5 fills this in) ------------------------ */

function buildSidebarLayout(appConfig, title) {
    // Placeholder so calls with sidebar.enabled don't throw before Task 5.
    // Falls back to floating for now.
    console.warn('[layout-manager] sidebar mode not yet implemented \u2014 falling back to floating');
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
