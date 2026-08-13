#!/bin/sh
set -eu
# Run after: bin/codextras apply deepseek-flash
# Verifies the live switch without starting a full Codex session.

PORT=$(sed -n 's/.*"port": *\([0-9]*\).*/\1/p' /Users/will/.agents/codextras/codextras.json | head -1)
if [ -z "$PORT" ]; then PORT=4200; fi
SECRET=$(cat /Users/will/.agents/codextras/state/secret)
BASE="http://127.0.0.1:$PORT/_codextras/$SECRET/v1"
CONFIG="$HOME/.codex/config.toml"

echo "1. gateway health"
curl -s --max-time 3 "http://127.0.0.1:$PORT/health" || exit 1

echo "2. config.toml points at codextras (root-level keys)"
python3 - "$CONFIG" "$PORT" <<'PY'
import sys, tomllib
cfg = tomllib.load(open(sys.argv[1], "rb"))
base = cfg.get("openai_base_url", "")
cat = cfg.get("model_catalog_json", "")
assert base.startswith("http://127.0.0.1:" + sys.argv[2] + "/_codextras/"), "missing/incorrect root openai_base_url: %r" % base
assert cat.endswith("merged-models.json"), "missing/incorrect root model_catalog_json: %r" % cat
PY
echo "ok"

echo "3. merged catalog contains deepseek-flash"
jq -e '.models[] | select(.slug == "deepseek-flash")' /Users/will/.agents/codextras/state/merged-models.json > /dev/null
echo "ok"

echo "4. tiny non-stream turn"
curl -s --max-time 60 "$BASE/responses" -H 'Content-Type: application/json' -d '{
  "model": "deepseek-flash",
  "input": [{"type":"message","role":"user","content":[{"type":"input_text","text":"Reply with exactly: ok"}]}],
  "stream": false
}' | jq -e '.status == "completed" and ([.output[].type] | index("message"))'
echo "ok"

echo "5. compaction"
curl -s --max-time 60 "$BASE/responses/compact" -H 'Content-Type: application/json' -d '{
  "model": "deepseek-flash",
  "input": [{"type":"message","role":"user","content":[{"type":"input_text","text":"remember 42"}]}]
}' | jq -e '.output[-1].type == "message"'
echo "ok"

echo "6. websocket upgrades refused with 426"
printf 'GET /_codextras/%s/v1/responses HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n' "$SECRET" | nc -w 3 127.0.0.1 "$PORT" | grep -q "426" || { echo "FAIL: upgrade not refused"; exit 1; }
echo "ok"

echo "ALL CHECKS PASSED"
