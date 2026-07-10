# Design decision: tool-call dialect parsing

**Status:** settled (2026-07-10). Revisit only if the "open follow-ups" below change.
**Tracking issue:** pinned `decision` issue on the repo.

## The recurring question

Across #288 / #295 / #296 / #297 we kept re-asking: is geo-agent's client-side
tool-call recovery — `parseEmbeddedToolCalls` and `looksLikeAttemptedToolCall` in
`app/agent.js` — reinventing existing art, or misplaced (should it live at the
inference server or in `open-llm-proxy`)? This note records the answer so we stop
re-deriving it.

We researched opencode, Cline/Roo, Aider, the inference-server layer
(vLLM / SGLang / llama.cpp / TGI), the Vercel AI SDK + `@ai-sdk-tool/parser`, and
measured our own `open-llm-proxy` S3 request/response logs.

## Findings

**1. Our server side is correct and *ahead* of the recommendation.**
The nimbus backend (`nvidia/Qwen3.6-35B-A3B-NVFP4`, GB10 / DGX Spark) runs
`--tool-call-parser qwen3_xml_patched` — a locally-patched `qwen3_xml` that fixes
vLLM #43713. That is newer and better than the model card's recipe
(`--tool-call-parser qwen3_coder`). Switching to `hermes` would fix the JSON-fallback
leaks but break the model's *primary* XML-format calls — a net loss. This is not a
misconfiguration. (Config lives in `boettiger-lab/k8s`, `vllm/nimbus/deploy-qwen.yaml`.)

**2. Residual leaks are inherent, not a bug we can fully close upstream.**
Measured from the proxy logs (which record the *raw* provider response, before geo-agent
recovery): ~3% of qwen tool-call attempts leak past the server parser (46 of ~1480
responses, 2026-06-10 → 07-09). ~40 of those were `<tool_call>{"name",…}` **JSON**
(Hermes-shape) that the **XML** parser structurally cannot read. Leaks are concentrated
on the qwen family; minimax-m2 / glm-5 / kimi / gpt-oss / claude / nemotron-ultra were
≈ 0%. **No single server parser covers both the XML and JSON shapes a weak model
intermittently emits** — so a residual will always slip past even the correct parser.

**3. No prior art does better on this specific problem** (residual leaks from weak open
models behind an OpenAI-compatible API):
- **opencode** has *no* client-side recovery and explicitly declined to add it
  (sst/opencode#2917, "not planned"); its users request exactly our re-prompt net
  (sst/opencode#13762). It bets on native `tool_calls` + server parsers + the Vercel AI SDK.
- **Cline / Roo** are our shape: native tool calls for *capable* models, text-parsing kept
  as the fallback for *weak / local* ones (Roo RFC #4047). Their parser is more polished
  but is for their own owned XML protocol.
- **Aider** parses edit-formats, not tool calls — a different problem.
- **`@ai-sdk-tool/parser`** (the Apache-2.0 project opencode declined to wire in) is
  *streaming* middleware for the Vercel AI SDK. **We don't stream and aren't on the SDK**,
  and it covers dialects we already cover. Not worth adopting.

## Decision

- **Keep the client-side recovery net.** It is correct, not a workaround. It is the one
  *universal* layer — it covers every backend, including apps that call OpenRouter
  directly and bypass `open-llm-proxy`. geo-agent is our only maintained harness, so all
  apps benefit from it.
- **Keep patching server parsers upstream** as bugs surface (as we did with
  `qwen3_xml_patched`). The server parser stays the primary path; the harness net is the
  catch for what leaks past it.
- **Do NOT** adopt `@ai-sdk-tool/parser`, migrate to the Vercel AI SDK, or chase native
  tool-calling as an escape hatch — for weak models "native" just moves failures from
  "wrong dialect" to "no `tool_calls` field at all".

## Open follow-ups (non-blocking; would change the decision if pursued)

- **The only thing that beats patching: constrained decoding.** `tool_choice:"required"`
  plus guided-JSON / grammar (or a llama.cpp-style lazy grammar) makes malformed tool
  output *impossible to emit* and drives the residual toward zero. Needs a measure/pilot
  on the NRP + nimbus vLLM builds. Caveats: grammar compilation adds latency, and
  `tool_choice:"required"` can force spurious calls on weak models when none was intended.
- **Cheap hygiene:** replace the hand-rolled lenient-JSON path with
  [`jsonrepair`](https://github.com/josdejong/jsonrepair) (ISC, browser UMD build,
  zero-dependency) — smaller maintenance surface than bespoke repair regex.

## How this was measured (reproducible)

`open-llm-proxy` logs every request/response to `s3://logs-open-llm-proxy` as
consolidated Parquet. Sync with the repo's `sync-logs.sh` (rclone `nrp:` remote), then in
DuckDB count responses where `has_tool_calls = false` but `entry.content` matches an
unambiguous tool-call marker (`<tool_call`, `<function=`, `<invoke`, `<model_calls`,
`<tool_code`, `<parameter[ =]`), grouped by `model` — that is the residual leak rate per
model, before geo-agent recovery.
