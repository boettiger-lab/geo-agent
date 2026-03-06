# Chat UI — Developer Review Notes

Items to investigate or verify after the tool-proposal description feature is deployed.

---

## 1. `message.content` is null for most models on tool calls

Many OpenAI-compatible models return `content: null` alongside `tool_calls`. The description
div only renders when content is non-empty, so for those models the new feature is a no-op.
Worth testing with the specific models configured in production to confirm whether the feature
actually fires. If it rarely fires, consider prompting the agent to always include a brief
plain-english sentence before calling a tool.

## 2. Approval buttons moved outside `<details>` — CSS assumptions

Previously the Run/Cancel buttons were the last child *inside* `<details open>`. They are now
*outside* `</details>`, as a sibling of it. The `.tool-approval-buttons` CSS (padding, margins,
border-radius) should be eyeballed to confirm it still looks right in this new structural
position, especially the bottom edge of the `.tool-block` card.

## 3. `<details>` defaults to closed for approval proposals

Previously non-auto-approved blocks used `<details open>` so the SQL was visible immediately.
Now `<details>` is always closed, relying on the description text above to orient the user.
If `reasoningText` is null/empty (see item 1), the user sees only a collapsed
`Details: <tool_name>` summary and the Run/Cancel buttons — no context at all. Consider
restoring `open` as a fallback when there is no description to show.

## 4. Potential XSS via `marked.parse()` on LLM content

The tool-reasoning div renders `reasoningText` through `marked.parse()` directly into
`innerHTML` without sanitization. In the current deployment this is low risk (trusted models,
internal use), but if the app is ever opened to arbitrary external models or user-supplied
endpoints, a sanitizer (e.g. DOMPurify) would be advisable.

## 5. Embedded tool-call stripping regex

The strip regex `/<tool_call>[\s\S]*?<\/tool_call>/gi` handles multiple calls correctly via
the lazy quantifier. Edge case: if a model ever uses a variant tag format or nests content
inside the tags, it could strip too much or too little. Low risk with current models.

## 6. `autoApproved` path computes but ignores description

For local (auto-approved) tools, `displayContent` is stripped and passed but the UI ignores it
(`!autoApproved` guard in `showToolProposal`). This is intentional — no description is shown
for auto-approved calls. If we later want brief descriptions there too, the hook is already in
place in both agent.js and chat-ui.js.
