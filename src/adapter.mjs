import { readFileSync } from "node:fs";
import { effortFor } from "./config.mjs";

export function providerHeaders(provider) {
  const key = resolveKey(provider);
  return {
    "Content-Type": "application/json",
    Accept: "text/event-stream, application/json",
    ...(key ? { Authorization: "Bearer " + key } : {}),
  };
}

function resolveKey(provider) {
  const envs = Array.isArray(provider.apiKeyEnv) ? provider.apiKeyEnv : [provider.apiKeyEnv];
  for (const name of envs) {
    if (!name) continue;
    const value = process.env[name];
    if (value) return value;
  }
  if (provider.apiKeyFile) {
    try {
      return readFileSync(provider.apiKeyFile, "utf8").trim();
    } catch {
      return "";
    }
  }
  return "";
}

export function buildChatBody({ payload, model, provider, messages, tools, stream }) {
  const quirks = provider.quirks || {};
  const body = {
    model: model.upstreamModel,
    messages,
    stream,
  };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  const requested = payload.reasoning && payload.reasoning.effort;
  const effort = effortFor(model, requested);
  if (model.reasoningContent !== false) {
    body.reasoning_effort = effort;
  }
  if (quirks.thinking) body.thinking = quirks.thinking;
  const effortMap = quirks.efforts;
  if (effortMap && typeof effortMap[effort] === "string") {
    body.reasoning_effort = effortMap[effort];
  }
  if (stream && quirks.streamOptions !== false) {
    body.stream_options = { include_usage: true };
  }
  const maxOutput = payload.max_output_tokens;
  if (maxOutput !== undefined && maxOutput !== null) body.max_tokens = maxOutput;
  return body;
}

export function chatUrl(provider) {
  return String(provider.baseUrl).replace(/\/$/, "") + "/chat/completions";
}
