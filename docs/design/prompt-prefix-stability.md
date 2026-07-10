# Design decision: prompt-prefix stability for caching

**Status:** settled (2026-07-10). Revisit only if the assembly path changes.
**Tracking issue:** #273 (suggestion 1 — the byte-stable-prefix half).

## The recurring question

Prompt caching — implicit provider prefix-caching (vLLM APC on NRP, provider-side
on OpenRouter) and the explicit `cache_control` breakpoint (#273, off by default)
— only pays off when the **leading bytes of the request are identical across
calls**. Any dynamic content placed early in the prefix invalidates the cache for
everything after it. #273 measured a 43%→76% cache-hit spread across providers and
asked: is geo-agent assembling an unstable prefix? This note records the audit
answer so we stop re-deriving it.

## Finding: the prefix is already byte-stable; the spread is provider-side

The request the agent sends is `{ model, messages, tools, tool_choice, user, …sampling }`
(`app/agent.js` `callLLM`). For caching, the cacheable prefix is the rendered
`tools` + `messages` — and the dominant chunk is the **system message** (base
prompt + injected dataset catalog + MCP analyst prompt, ~34k tokens for a large
catalog, per #294). The audit confirms every part of that prefix is stable:

1. **The system prompt is built once and frozen.** `main.js` assembles
   `basePrompt + '\n\n' + catalog.generatePromptCatalog() + '\n\n' + analystPrompt`
   at bootstrap and calls `agent.setSystemPrompt()` exactly once. Nothing mutates
   `agent.systemPrompt` afterward — `processMessage` reads it verbatim into
   `messages[0]` every turn, and `chat-ui.js` only calls `processMessage(text)`
   (it never injects leading context or edits the system prompt).
2. **The catalog is deterministic.** `generatePromptCatalog()` iterates
   `datasets.values()` in Map-insertion order (fixed by the `collections` config)
   and contains no dates, RNG, or unstable set/dict iteration. Same config → same
   bytes, run to run and pod to pod (so cross-session cold-start hits are possible
   too, not just within-session).
3. **No dynamic content lands in the prefix.** The only `Date.now()` /
   `crypto.randomUUID()` / `Math.random()` in the codebase are outside the prefix:
   the session id is a top-level `user` field (not prompt tokens), and the rest are
   UI timers, chat-export filenames, and synthetic tool-call ids (which live in the
   per-turn suffix). No "current date" / "today" is injected.
4. **Volatile content is strictly last.** Conversation turns and tool results
   follow the system message; the growing, uncacheable tail is where it belongs.

**Evidence the spread is provider-side, not ours.** Production vLLM prefix-cache
hit rates (Prometheus, 7d) vary from **13% to 74%** *across models* on the same
serving stack — Kimi 13%, GLM 16%, gemma 18–20%, gpt-oss 27%, Qwen3.6 42%,
Qwen3.5 50%, MiniMax 74%. Since geo-agent sends the identical prefix regardless of
model, a 13–74% range can only be a per-backend cache property (APC config,
KV-cache pressure, eviction, batching), not prompt assembly. The audit therefore
found **no harness-side fix** for the #273 spread.

## The invariant (rules for future changes)

Keep the prefix stable. Concretely, in `main.js` / `dataset-catalog.js` / `agent.js`:

- **Never inject dynamic content into `systemPrompt`** — no `Date`/`now()`/random,
  no per-turn map state, no session/user id, no "current date". If the model needs
  volatile context, put it in a **user-turn message** (or, for operator instructions
  on supporting models, a mid-conversation `role:"system"` message), never ahead of
  the cached prefix.
- **Keep catalog rendering deterministic** — no unsorted set/dict iteration, no
  timestamps. If a new field is added, ensure identical config → identical bytes.
- **Don't reorder tools mid-session.** `getToolsForLLM()` relies on stable Map
  insertion order (locals, then MCP tools in server-advertised order). A reconnect
  re-registers in the same order; keep it that way.

`test/agent-prefix-stability.test.js` guards the load-bearing part: the outgoing
system message is byte-identical across turns and equals the frozen `systemPrompt`.

## Known limitation (accepted, not a bug)

The context window is `this.messages.slice(-12)` (`agent.js`), a sliding window.
Once a conversation exceeds 12 messages, the tokens *immediately after* the system
prompt shift each turn, so the conversation body never accrues incremental
cross-turn cache hits — only the **system prefix** caches turn-to-turn. That is
acceptable: the system prefix is by far the largest chunk, so we already capture
the dominant win, and the window exists for context-budget reasons. Restructuring
to an append-only history for marginal conversation-tail caching isn't worth it.

## Relationship to the explicit `cache_control` breakpoint (#273)

The per-model `prompt_cache` flag (merged, off by default) adds an explicit
Anthropic `cache_control` breakpoint on the system message. That is a **cost** lever
for Claude only and is currently a no-op: the open-llm-proxy routes Claude to
Anthropic's OpenAI-compat endpoint, which ignores message-embedded `cache_control`
(see open-llm-proxy#75). This note covers the *implicit* prefix caching that every
backend already does for free — which the audit confirms we are not undermining.

Also note (#282): 72–98% of LLM compute *time* is decode, so prefix caching is a
cost lever with ~zero latency benefit. Latency comes from fewer round-trips
(#281), smaller outputs, and reasoning-off (#283).
