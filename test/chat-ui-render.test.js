// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { renderMarkdown } from '../app/chat-ui.js';

// chat-ui.js consumes marked and DOMPurify as page globals (CDN script
// tags); mirror that here with the real libraries.
beforeAll(() => {
    globalThis.marked = marked;
    globalThis.DOMPurify = DOMPurify;
});

afterEach(() => {
    globalThis.marked = marked;
    globalThis.DOMPurify = DOMPurify;
});

const render = (md) => {
    const el = document.createElement('div');
    el.innerHTML = renderMarkdown(md);
    return el;
};

describe('renderMarkdown sanitization', () => {
    it('strips event-handler XSS that marked passes through', () => {
        const el = render('Here is the result: <img src=x onerror="window.__pwned=1">');
        expect(el.querySelector('img[onerror]')).toBeNull();
        expect(renderMarkdown('x <img src=x onerror=alert(1)>')).not.toContain('onerror');
    });

    it('strips script tags', () => {
        expect(renderMarkdown('hello <script>alert(1)</script> world')).not.toContain('<script');
    });

    it('strips javascript: URLs in links', () => {
        const el = render('[click me](javascript:alert(1))');
        const a = el.querySelector('a');
        if (a) expect(a.getAttribute('href') || '').not.toMatch(/^javascript:/i);
    });

    it('preserves markdown tables', () => {
        const el = render('| a | b |\n|---|---|\n| 1 | 2 |');
        expect(el.querySelector('table')).not.toBeNull();
        expect(el.querySelectorAll('td')).toHaveLength(2);
    });

    it('preserves fenced code blocks with language class (hljs hook)', () => {
        const el = render('```sql\nSELECT 1;\n```');
        const code = el.querySelector('pre code');
        expect(code).not.toBeNull();
        expect(code.className).toContain('language-sql');
        expect(code.textContent).toContain('SELECT 1;');
    });

    it('preserves ordinary links', () => {
        const el = render('[docs](https://example.com/page)');
        expect(el.querySelector('a[href="https://example.com/page"]')).not.toBeNull();
    });

    it('scrubs credential-shaped tokens before rendering (SEC-4)', () => {
        const out = renderMarkdown("Run: CREATE SECRET (KEY_ID 'AKIAXXXX', SECRET 'shhh-very-secret');");
        expect(out).not.toContain('AKIAXXXX');
        expect(out).not.toContain('shhh-very-secret');
        expect(out).toContain('[REDACTED]');
    });

    it('fails closed (escaped text, no raw HTML) when DOMPurify is missing', () => {
        delete globalThis.DOMPurify;
        const el = render('**bold** <img src=x onerror=alert(1)>');
        expect(el.querySelector('img')).toBeNull();
        expect(el.textContent).toContain('<img');
    });

    it('fails closed when marked is missing', () => {
        delete globalThis.marked;
        const el = render('<img src=x onerror=alert(1)>');
        expect(el.querySelector('img')).toBeNull();
    });
});
