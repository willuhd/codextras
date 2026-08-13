# AGENTS.md

Pure-Bun Codex gateway: ChatCompletions <-> Responses for the Codex desktop/CLI
app, zero npm dependencies, no build step. Declared models route to
OpenAI-compatible chat providers; undeclared models pass through to the
signed-in ChatGPT backend.

## Commands

    bin/codextras start|stop|status     daemonize via nohup + pidfile
    bin/codextras catalog               declared-models catalog
    bin/codextras catalog-merged        capture native catalog + write state/merged-models.json
    bin/codextras dry-run [alias]       render future config.toml without writing
    bin/codextras apply [alias]         backup + switch ~/.codex/config.toml to codextras
    bin/codextras restore               restore the pre-codextras config.toml
    bun test                            unit tests (stop the gateway first: port conflict)
    ./smoke/verify-after-switch.sh      live checks (needs gateway running + real upstream key)

## Architecture

    src/server.mjs          Bun.serve: /v1/responses, /v1/responses/compact, /v1/models, WS refused with 426
    src/adapter.mjs         chat request builder (thinking envelope, efforts, stream_options)
    src/convert/request.mjs Responses items -> chat messages (reasoning, tools, images, compaction)
    src/convert/tools.mjs   custom/freeform tool bridge (exec etc.)
    src/convert/stream.mjs  chat SSE -> Responses SSE lifecycle
    src/convert/json.mjs    non-streaming chat -> Responses
    src/catalog.mjs         catalog entry generation + native merge + visibility overrides
    src/codex-config.mjs    config.toml managed-block rendering
    src/compaction.mjs      compaction v1/v2 with kcr1: summary envelope

## Onboarding: configure a model

Edit `codextras.json`. Providers are OpenAI-compatible chat endpoints; quirks
carry per-provider differences as data (thinking envelope, effort aliases,
stream_options). Relative `apiKeyFile` paths resolve against the repo root.

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

Then `bin/codextras apply <alias>` and restart the Codex app (it caches the
catalog). `catalogOverrides` can force native-model visibility (e.g.
`{"gpt-5.2": {"visibility": "hide"}}`).

## Hard-won constraints

- The managed block in config.toml must stay at the TOP of the file: root keys
  (`openai_base_url`, `model_catalog_json`) land inside whatever table precedes
  them otherwise, and Codex silently ignores them.
- Reasoning is preserved twice: `reasoning_content` on assistant messages (the
  DeepSeek API contract when tools are present) AND a visible `<thought>`
  block (the model's only real memory). Never use `<think>`: the upstream's
  reasoning parser strips that exact tag from assistant content.
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

1. `bin/codextras stop && bun test && bin/codextras start`
2. `./smoke/verify-after-switch.sh` (health, config.toml root keys, catalog,
   real upstream turn, compaction, WS 426)
3. `bin/codextras apply <alias>`, then the Codex app must be fully quit and
   reopened to reload the catalog.

## Conventions

Bun-only, no npm dependencies, no build step. Match the existing style (ESM,
plain functions, minimal abstraction). Add unit tests for conversion logic in
test/gateway.test.mjs; live behaviors belong in the smoke script.
