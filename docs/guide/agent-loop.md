# Agent Loop: How the Chat Agent Works

This document describes the agentic tool-use loop in detail, with a focus on how tool proposals are shown to users, how pre-call explanations are generated, and how to extend or modify this behavior.

## Overview

The agent runs in `app/agent.js`. When the user sends a message, `processMessage()` enters a `while` loop that:

1. Calls the LLM with the full conversation history + tool schemas
2. Inspects the response:
   - If `tool_calls` are present → propose them to the user → (await approval if non-local) → execute → append results → **loop**
   - If no tool calls → emit the final text response → **done**

```
user message
    │
    ▼
┌─────────────────────────────────────────┐
│ callLLM() → message                     │
│                                         │
│  message.content  (text, may be null)   │
│  message.tool_calls  (may be empty)     │
└───────────────┬─────────────────────────┘
                │
        tool_calls present?
               / \
             yes   no
              │     └──► emit final response → done
              ▼
    allLocal? (map tools only)
        / \
      yes   no
       │     └──► onToolProposal() → await user approval
       │                   │
       │          approved? no → cancelled
       │                   │ yes
       └──────────────────►▼
                    execute tools
                    append results to turnMessages
                    loop back to callLLM()
```

## Key files

| File | Role |
|---|---|
| `app/agent.js` | The agentic loop, LLM calls, tool dispatch |
| `app/chat-ui.js` | All DOM rendering — proposal blocks, results, approval buttons |
| `app/tool-registry.js` | Unified registry: local tools vs. remote (MCP) tools |
| `app/system-prompt.md` | LLM instructions, including the pre-call explanation rule |

## Local vs. remote tools

Tools registered via `toolRegistry.registerLocal()` (the map tools) are **auto-approved** — they run silently with a collapsed "Running: …" block. No user interaction needed.

The local map tools include: `show_layer`, `hide_layer`, `set_filter`, `reset_filter`, `set_style`, `get_dataset_details`, `list_datasets`, `fly_to`, and others. `fly_to` animates the map to any location — the agent looks up coordinates from parquet data via H3 SQL rather than guessing.

Tools registered via `toolRegistry.registerRemote()` (the MCP `query` tool) require **explicit user approval** — a "Details: query" block appears with Approve / Cancel buttons.

This distinction is checked with `toolRegistry.isLocal(name)` in `agent.js`.

### Auto-approve toggle

A toggle in the chat UI lets users switch remote tools to auto-approve mode, skipping the Approve / Cancel prompt for the rest of the session. Useful when running a series of analytical queries without wanting to confirm each one. The setting is session-only — it resets on page reload.

### Credential redaction

Tool call arguments displayed in the UI are filtered to strip S3 credentials, API tokens, and similar secrets before rendering. This applies to both the collapsed "Running: …" blocks and the expanded Details view, so sensitive values injected into SQL or tool parameters are never shown to the user.

## Pre-call explanation: how it works

When the LLM returns a response with tool calls, it often (but not always) includes a `message.content` alongside the `tool_calls`. This text is the model's reasoning — its natural-language explanation of what it's about to do.

In `agent.js`, this content is extracted and stripped of any embedded `<tool_call>` XML tags:

```js
const displayContent = message.content
    ? message.content.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '').trim()
    : null;
```

`displayContent` is then passed to `onToolProposal()` → `chat-ui.js:showToolProposal()`, which renders it as a `<div class="tool-reasoning">` above the approval buttons.

```
┌──────────────────────────────────────────────┐
│ tool-reasoning div (plain-english text)      │  ← displayContent
│ ► Details: query                             │  ← collapsible <details>
│   [Approve]  [Cancel]                        │
└──────────────────────────────────────────────┘
```

## The fallback: `describeToolCalls()`

When `displayContent` is null or empty (the model returned tool calls with no accompanying text), `chat-ui.js` falls back to `describeToolCalls()`. This function parses the SQL to produce a synthetic description:

- Extracts `read_parquet(...)` paths → short two-segment table names
- Detects JOINs, aggregate functions (SUM/AVG/COUNT/MIN/MAX), WHERE, GROUP BY, ORDER BY + LIMIT
- Builds a sentence like: *"Computing aggregates joining `mule-deer/h3` with `pronghorn/h3`, filtered by conditions."*

This is deterministic and always produces something meaningful, but it reads less naturally than model-generated text.

## The recurring problem: silent follow-up calls

The system prompt instructs the LLM to explain before every `query` call (see `app/system-prompt.md` → "Before every remote tool call"). The LLM tends to follow this for the **first** call in a turn, because it's in a "responding to the user" frame of mind. For **subsequent iterations** — after receiving tool results and deciding it needs another query — it's in a "making progress on a task" frame of mind and often emits `message.content = null` alongside the tool call.

The result: the second (and later) approval prompts show only `describeToolCalls()` output, not a fluent model-written explanation.

### Current approach (Plan A)

The system prompt has been made more emphatic — using "**Every time**", "**without exception**", and explicit examples for follow-up calls. Combined with the improved `describeToolCalls()` fallback, this handles most cases adequately.

### Alternative: per-iteration reminder injection (Plan B)

A more reliable approach is to inject a brief ephemeral reminder into `turnMessages` after each tool result batch, just before the next `callLLM()`:

```js
// In agent.js, inside the while loop, after appending tool results:
if (!allLocal) {
    turnMessages.push({
        role: 'user',
        content: 'If you need another query, first explain in one sentence what it will determine, then call the tool.'
    });
}
```

Because `turnMessages` is a local array scoped to the current turn (not persisted in `this.messages`), this doesn't pollute the conversation history. It directly re-activates the instruction at the moment the model decides whether to make another call.

**Trade-off:** Adds a synthetic user message visible to the model at each step. In practice this is very effective. We haven't done this yet because the strengthened system prompt is simpler and sufficient for well-behaved models.

### Alternative: lightweight "explain" LLM call

Before presenting a proposal that has no `displayContent`, make a second lightweight LLM call with a minimal prompt:

```js
// Pseudo-code
if (!displayContent && !allLocal) {
    displayContent = await this.getExplanation(calls, turnMessages);
}
```

Where `getExplanation` sends just the SQL + a one-line instruction ("Summarize this query in one sentence") to the LLM with `max_tokens: 80`.

**Trade-off:** Always produces fluent model-written text, but adds latency and API cost on every subsequent SQL call. Best suited if model compliance with Plan A/B is poor.

### Alternative: structured `explanation` field in tool schema

Add a required `explanation` parameter to the `query` tool's JSON schema:

```json
{
    "name": "query",
    "inputSchema": {
        "properties": {
            "explanation": {
                "type": "string",
                "description": "One sentence plain-English description of what this query will determine."
            },
            "sql_query": { "type": "string" }
        },
        "required": ["explanation", "sql_query"]
    }
}
```

The model is then forced to supply an explanation as a structured argument, which `showToolProposal()` can extract and display. This is the most robust approach for structured-output-capable models, but requires changes to the MCP server schema and the rendering logic.

## Conversation history vs. turn messages

There are two separate message arrays:

- `this.messages` (persisted across turns) — stored in `Agent`, grows with each user/assistant exchange, trimmed to last 12 for context
- `turnMessages` (ephemeral per turn) — built fresh each turn from `[system] + this.messages.slice(-12)`, extended with tool call/result pairs during the loop

Only the final assistant text response is pushed into `this.messages`. Tool call/result pairs live only in `turnMessages` and are not re-used in future turns (the LLM sees a summary of previous turns via the assistant message, not raw tool results).
