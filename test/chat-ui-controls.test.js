// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { ChatUI } from '../app/chat-ui.js';
import { Agent } from '../app/agent.js';

/**
 * #255 — checkpoint resume folded into the chat input. These exercise the
 * 3-state send button (Send / Stop / Continue), the abandon control, and the
 * empty-input "Continue" resume, without standing up the full ChatUI (which
 * wires voice, model selector, links, etc.). We drive the prototype methods on
 * a minimal instance, mirroring the map-manager unit tests.
 */
function makeUI({ busy = false, suspendedTurn = null } = {}) {
    const ui = Object.create(ChatUI.prototype);
    ui.busy = busy;
    ui.agent = { suspendedTurn };
    ui.config = {};
    ui.sendBtn = document.createElement('button');
    ui.abandonBtn = document.createElement('button');
    ui.inputEl = document.createElement('textarea');
    ui._defaultPlaceholder = 'Ask about the data…';
    ui.inputEl.placeholder = ui._defaultPlaceholder;
    ui._messages = [];
    ui.addMessage = (role, text) => ui._messages.push({ role, text });
    return ui;
}

describe('ChatUI._syncInputControls (#255)', () => {
    it('idle → Send, no abandon, default placeholder', () => {
        const ui = makeUI();
        ui._syncInputControls();
        expect(ui.sendBtn.textContent).toBe('Send');
        expect(ui.sendBtn.classList.contains('stop')).toBe(false);
        expect(ui.sendBtn.classList.contains('continue')).toBe(false);
        expect(ui.abandonBtn.hidden).toBe(true);
        expect(ui.inputEl.placeholder).toBe('Ask about the data…');
    });

    it('busy → Stop, abandon stays hidden even if a turn is suspended', () => {
        const ui = makeUI({ busy: true, suspendedTurn: { turnMessages: [] } });
        ui._syncInputControls();
        expect(ui.sendBtn.textContent).toBe('■');
        expect(ui.sendBtn.classList.contains('stop')).toBe(true);
        expect(ui.sendBtn.classList.contains('continue')).toBe(false);
        expect(ui.abandonBtn.hidden).toBe(true);
    });

    it('suspended + idle → Continue, abandon visible, hint placeholder', () => {
        const ui = makeUI({ suspendedTurn: { turnMessages: [] } });
        ui._syncInputControls();
        expect(ui.sendBtn.textContent).toBe('Continue');
        expect(ui.sendBtn.classList.contains('continue')).toBe(true);
        expect(ui.sendBtn.classList.contains('stop')).toBe(false);
        expect(ui.abandonBtn.hidden).toBe(false);
        expect(ui.inputEl.placeholder).toMatch(/Continue/);
    });
});

describe('ChatUI.abandonSuspendedTurn (#255)', () => {
    it('clears the suspended turn, resets to Send, and notes it', () => {
        const ui = makeUI({ suspendedTurn: { turnMessages: [] } });
        ui.abandonSuspendedTurn();
        expect(ui.agent.suspendedTurn).toBeNull();
        expect(ui.sendBtn.textContent).toBe('Send');
        expect(ui.abandonBtn.hidden).toBe(true);
        expect(ui._messages.at(-1)).toMatchObject({ role: 'system' });
    });

    it('is a no-op while busy', () => {
        const ui = makeUI({ busy: true, suspendedTurn: { keep: 1 } });
        ui.abandonSuspendedTurn();
        expect(ui.agent.suspendedTurn).toEqual({ keep: 1 });
        expect(ui._messages).toHaveLength(0);
    });
});

describe('ChatUI.handleSend resume semantics (#255)', () => {
    function wireTurnStubs(ui) {
        const sent = [];
        ui.agent.processMessage = async (t) => { sent.push(t); return { response: 'ok', cancelled: false }; };
        ui._autoResizeInput = () => {};
        ui.startTurn = () => {};
        ui.endTurn = () => {};
        ui.addMarkdown = () => {};
        ui.scrollToBottom = () => {};
        return sent;
    }

    it('empty input resumes a suspended turn with "continue"', async () => {
        const ui = makeUI({ suspendedTurn: { turnMessages: [] } });
        const sent = wireTurnStubs(ui);
        ui.inputEl.value = '';
        await ui.handleSend();
        expect(sent).toEqual(['continue']);
    });

    it('empty input with no suspended turn does nothing', async () => {
        const ui = makeUI();
        const sent = wireTurnStubs(ui);
        ui.inputEl.value = '   ';
        await ui.handleSend();
        expect(sent).toEqual([]);
    });

    it('a typed steer takes precedence over the canned continue', async () => {
        const ui = makeUI({ suspendedTurn: { turnMessages: [] } });
        const sent = wireTurnStubs(ui);
        ui.inputEl.value = 'use the viridis palette';
        await ui.handleSend();
        expect(sent).toEqual(['use the viridis palette']);
    });
});

describe('ChatUI reasoning toggle (#283)', () => {
    const stubRegistry = { getToolsForLLM: () => [], isLocal: () => true, execute: async () => ({}), has: () => false };

    // Minimal ChatUI wired to a real Agent so the capability/state gating
    // (which lives on the Agent) is exercised end-to-end.
    function makeUI(models) {
        const ui = Object.create(ChatUI.prototype);
        ui.agent = new Agent({ llm_models: models }, stubRegistry);
        ui.footerRightEl = document.createElement('div');
        return ui;
    }

    it('hides the toggle for a non-capable model', () => {
        const ui = makeUI([{ value: 'plain', endpoint: 'e', api_key: 'k' }]);
        ui.initReasoningToggle();
        expect(ui.reasoningBtn.style.display).toBe('none');
    });

    it('shows the toggle, defaulting to the configured state', () => {
        const ui = makeUI([{ value: 'r', endpoint: 'e', api_key: 'k', reasoning_toggle: true, reasoning_default: true }]);
        ui.initReasoningToggle();
        expect(ui.reasoningBtn.style.display).toBe('');
        expect(ui.reasoningBtn.classList.contains('active')).toBe(true);
    });

    it('click flips the effective state and the agent override', () => {
        const ui = makeUI([{ value: 'r', endpoint: 'e', api_key: 'k', reasoning_toggle: true, reasoning_default: true }]);
        ui.initReasoningToggle();
        ui.reasoningBtn.click();
        expect(ui.agent.reasoningOverride).toBe(false);
        expect(ui.reasoningBtn.classList.contains('active')).toBe(false);
    });

    it('capable-but-undefined default displays as on', () => {
        const ui = makeUI([{ value: 'r', endpoint: 'e', api_key: 'k', reasoning_toggle: true }]);
        ui.initReasoningToggle();
        expect(ui.reasoningState()).toBe(true);
    });
});
