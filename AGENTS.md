# AGENTS.md

Pure-Bun Codex gateway: ChatCompletions <-> Responses for the Codex desktop/CLI
app, zero npm dependencies. Declared models route to chat (OpenAI-compatible)
*or* Responses providers; undeclared models pass through to the signed-in
ChatGPT backend. Distributed as a compiled binary (`bun run build` ->
`codextras`); run it wherever you install it and state/, logs/,
codextras.json resolve next to it.

## Commands

    codextras start|stop|status       daemonize via pidfile
    codextras catalog                 declared-models catalog
    codextras catalog-merged          capture native catalog + write state/merged-models.json
    codextras dry-run [alias]         render future config.toml without writing
    codextras apply [alias]           backup + switch ~/.codex/config.toml to codextras
    codextras restore                 restore the pre-codextras config.toml
    bun run build                     compile the binary (src/cli.mjs)
    bun test                          unit tests (stop the gateway first: port conflict)
    ./smoke/verify-after-switch.sh    live checks (needs gateway running + real upstream key)

## Architecture

    src/server.mjs          Bun.serve: /v1/responses, /v1/responses/compact, /v1/models, WS refused with 426
    src/adapter.mjs         chat + Responses builders (thinking envelope, efforts, include, store, stream_options)
    src/convert/request.mjs Responses items -> chat messages (reasoning, tools, images, compaction) + flattenToolsForResponses
    src/convert/tools.mjs   custom/freeform tool bridge (exec etc.)
    src/convert/stream.mjs  chat SSE -> Responses SSE lifecycle (responses upstream is proxied verbatim)
    src/convert/json.mjs    non-streaming chat -> Responses
    src/catalog.mjs         catalog entry generation + native merge + visibility overrides (supports_reasoning_summaries toggleable)
    src/codex-config.mjs    config.toml managed-block rendering
    src/compaction.mjs      compaction v1/v2 with kcr1: summary envelope (chat or responses per provider)

## Onboarding: configure a model

Edit `codextras.json`. Providers are OpenAI-compatible chat **or Responses**
endpoints; `provider.type` (or `wireApi`/`api`) selects the wire format.
`type: "openai-chat"` (default) → `/chat/completions` with Chat↔Responses
bridging (needed for DeepSeek); `type: "openai-responses"` →
`/responses` with verbatim Responses passthrough (needed for Muse Spark,
preserves `reasoning.encrypted_content` + true multimodal). All three
dimensions are toggleable per-model: vision via `inputModalities` +
`imagePassthrough`, wire format via `provider.type` *or* `model.wireApi`/`model.api`,
and reasoning via `reasoningInjection`/`disableThoughtHack` +
`reasoningSummary`/`supportsReasoningSummaries`. Quirks carry per-provider
differences as data (thinking envelope, effort aliases, stream_options,
`include`). Relative `apiKeyFile` paths resolve against the repo root.

Example (opencode-go provider + DeepSeek V4 Flash):

```json
{
  "gateway": { "port": 4200, "pathPrefix": "/_codextras" },
  "providers": [
    {
      "id": "opencode-go",
      "type": "openai-chat",
      "baseUrl": "https://opencode.ai/zen/go/v1",
      "apiKeyEnv": ["OPENCODE_API_KEY", "OPENCODE_GO_API_KEY"],
      "apiKeyFile": "./state/opencode-go-api-key.secret",
      "quirks": {
        "thinking": { "type": "enabled" },
        "efforts": { "low": "low", "high": "high", "max": "max" },
        "streamOptions": true
      }
    }
  ],
  "models": [
    {
      "alias": "deepseek-flash",
      "displayName": "V4 Flash",
      "provider": "opencode-go",
      "upstreamModel": "deepseek-v4-flash",
      "contextWindow": 1048576,
      "autoCompact": 900000,
      "efforts": ["low", "high", "max"],
      "defaultEffort": "high",
      "inputModalities": ["text", "image"],
      "imagePassthrough": false
    }
  ]
}
```

Then `codextras apply <alias>` and restart the Codex app (it caches the
catalog). `catalogOverrides` can force native-model visibility (e.g.
`{"gpt-5.2": {"visibility": "hide"}}`).

Dual-provider example (DeepSeek on chat + Muse Spark on Responses, same key):

```json
{
  "providers": [
    { "id": "opencode-go-chat", "type": "openai-chat", "baseUrl": "https://opencode.ai/zen/go/v1", "apiKeyEnv": ["OPENCODE_API_KEY"], "quirks": { "thinking": { "type": "enabled" }, "efforts": { "low": "low", "high": "high", "max": "max" } } },
    { "id": "opencode-go-responses", "type": "openai-responses", "baseUrl": "https://opencode.ai/zen/go/v1", "apiKeyEnv": ["OPENCODE_API_KEY"], "quirks": { "efforts": { "minimal": "minimal", "low": "low", "medium": "medium", "high": "high", "xhigh": "xhigh" }, "include": ["reasoning.encrypted_content"], "reasoningSummary": "auto", "store": false } }
  ],
  "models": [
    { "alias": "deepseek-flash", "provider": "opencode-go-chat", "upstreamModel": "deepseek-v4-flash", "efforts": ["low","high","max"], "defaultEffort": "high", "inputModalities": ["text","image"], "imagePassthrough": false },
    { "alias": "muse-spark", "provider": "opencode-go-responses", "upstreamModel": "muse-spark-1.2", "efforts": ["minimal","low","medium","high","xhigh"], "defaultEffort": "high", "inputModalities": ["text","image"], "imagePassthrough": true, "supportsReasoningSummaries": true, "reasoningSummary": "auto" }
  ]
}
```
Alternative single-provider toggle: set `"api": "responses"` (or `wireApi`/`targetApi`) per `models[]` entry to override the provider’s wire format — same `type` field works per-model. Vision (`imagePassthrough`), wire format, and `<thought>` hack are all toggleable.

## Hard-won constraints

- The managed block in config.toml must stay at the TOP of the file: root keys
  (`openai_base_url`, `model_catalog_json`) land inside whatever table precedes
  them otherwise, and Codex silently ignores them.
- Reasoning is preserved twice for **chat** providers: `reasoning_content` on
  assistant messages (the DeepSeek API contract when tools are present) AND a
  visible `<thought>` block (the model's only real memory). Never use
  `<think>`: the upstream's reasoning parser strips that exact tag from
  assistant content. **Responses** providers (Muse Spark) do not use this
  hack — they replay `reasoning.encrypted_content` via `include` + `store:false`
  and should disable it with `reasoningInjection:"none"` / `disableThoughtHack`.
  Muse’s `summary` is empty today (encrypted only).
- Custom tools (exec) are advertised as functions with a single required
  `content` string property and returned as `custom_tool_call` items (see
  convert/tools.mjs). This mirrors the proven LiteLLM bridge; the app's tool
  router rejects plain `function_call` items for freeform tools.
- Catalog entries require `experimental_supported_tools` and should set
  `prefer_websockets: false`; Codex falls back to its built-in catalog if the
  file fails to parse.
- WebSocket upgrades get `426` on purpose: Codex falls back to HTTP streaming
  immediately. Do not add a WS endpoint.
- `state/` and `logs/` hold secrets (gateway token, provider API key, catalog
  JSONs). Never commit them.

## Verification loop

1. `codextras stop && bun test && codextras start`
2. `./smoke/verify-after-switch.sh` (health, config.toml root keys, catalog,
   real upstream turn, compaction, WS 426)
3. `codextras apply <alias>`, then the Codex app must be fully quit and
   reopened to reload the catalog.

## Conventions

Bun-only, no npm dependencies, no build step. Match the existing style (ESM,
plain functions, minimal abstraction). Add unit tests for conversion logic in
test/gateway.test.mjs; live behaviors belong in the smoke script.
