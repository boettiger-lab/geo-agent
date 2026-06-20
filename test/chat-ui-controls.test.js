// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { ChatUI } from '../app/chat-ui.js';

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
