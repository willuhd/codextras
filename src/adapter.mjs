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
    body.tool_choice = payload.tool_choice ?? "auto";
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

export function isResponsesProvider(provider) {
  if (!provider || typeof provider !== "object") return false;
  const type = typeof provider.type === "string" ? provider.type.toLowerCase() : "";
  if (type.includes("responses")) return true;
  if (type === "openai" && provider.wireApi === "responses") return true;
  if (typeof provider.wireApi === "string" && provider.wireApi.toLowerCase() === "responses") return true;
  if (typeof provider.api === "string" && provider.api.toLowerCase() === "responses") return true;
  if (typeof provider.apiType === "string" && provider.apiType.toLowerCase() === "responses") return true;
  return false;
}

export function isResponsesModel(model, provider) {
  if (!model || typeof model !== "object") return isResponsesProvider(provider);
  const mApi =
    typeof model.api === "string"
      ? model.api
      : typeof model.wireApi === "string"
        ? model.wireApi
        : typeof model.apiType === "string"
          ? model.apiType
          : typeof model.targetApi === "string"
            ? model.targetApi
            : undefined;
  if (typeof mApi === "string") {
    const v = mApi.toLowerCase();
    if (v.includes("responses")) return true;
    if (v.includes("chat") || v.includes("completions")) return false;
  }
  return isResponsesProvider(provider);
}

export function responsesUrl(provider) {
  return String(provider.baseUrl).replace(/\/$/, "") + "/responses";
}

export function supportsResponsesCustomTools(model, provider) {
  for (const value of [
    model && model.supportsCustomTools,
    provider && provider.supportsCustomTools,
    provider && provider.quirks && provider.quirks.supportsCustomTools,
  ]) {
    if (typeof value === "boolean") return value;
  }
  return true;
}

export function buildResponsesBody({ payload, model, provider, input, tools, stream }) {
  const quirks = provider.quirks || {};
  const body = {
    model: model.upstreamModel,
    input,
    stream,
  };
  if (typeof payload.instructions === "string" && payload.instructions.trim()) {
    body.instructions = payload.instructions;
  }
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = payload.tool_choice ?? "auto";
  }
  const requested = payload.reasoning && payload.reasoning.effort;
  const effort = effortFor(model, requested);
  if (model.reasoningContent !== false && effort) {
    body.reasoning = { effort };
    // allow quirks.efforts alias (e.g. max -> xhigh)
    const effortMap = quirks.efforts;
    if (effortMap && typeof effortMap[effort] === "string") {
      body.reasoning.effort = effortMap[effort];
    }
    // optional summary control (e.g. "auto" for Muse)
    if (typeof quirks.reasoningSummary === "string") {
      body.reasoning.summary = quirks.reasoningSummary;
    } else if (typeof model.reasoningSummary === "string") {
      body.reasoning.summary = model.reasoningSummary;
    }
  }
  if (quirks.thinking) body.thinking = quirks.thinking;
  // encrypted reasoning replay (Muse Spark) — provider or model level
  const include = quirks.include || model.include;
  if (Array.isArray(include) && include.length) body.include = include;
  // stateless: do not require server-side storage
  if (quirks.store !== undefined) body.store = quirks.store;
  else if (model.store !== undefined) body.store = model.store;
  else body.store = false;
  if (payload.previous_response_id) body.previous_response_id = payload.previous_response_id;
  if (payload.truncation) body.truncation = payload.truncation;
  const maxOutput = payload.max_output_tokens;
  if (maxOutput !== undefined && maxOutput !== null) body.max_output_tokens = maxOutput;
  return body;
}

export function chatUrl(provider) {
  return String(provider.baseUrl).replace(/\/$/, "") + "/chat/completions";
}
