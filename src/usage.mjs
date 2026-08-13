import { estimateTokensFromBytes, estimateTokensFromText } from "./util.mjs";

function tokenCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : undefined;
}

export function normalizeUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const inputTokens = tokenCount(value.input_tokens ?? value.prompt_tokens);
  const outputTokens = tokenCount(value.output_tokens ?? value.completion_tokens);
  const explicitTotal = tokenCount(value.total_tokens);
  const totalTokens =
    explicitTotal ??
    (inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens || 0) + (outputTokens || 0)
      : undefined);
  if (totalTokens === undefined) return undefined;
  return {
    input_tokens: inputTokens || 0,
    output_tokens: outputTokens || 0,
    total_tokens: totalTokens,
  };
}

export function usageFromPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  for (const candidate of [payload.usage, payload.response && payload.response.usage]) {
    const usage = normalizeUsage(candidate);
    if (usage) return usage;
  }
  return undefined;
}

// Real numbers win. When a provider reports zero input (or nothing at all),
// substitute the same bytes/4 heuristic Codex itself uses so the context donut
// and auto-compact accounting stay truthful.
export function finalizeUsage(payloadUsage, fallback) {
  let usage = normalizeUsage(payloadUsage) || null;
  const fallbackInput = fallback ? fallback.inputTokens : undefined;
  const fallbackOutput = fallback ? fallback.outputTokens : undefined;
  if (!usage) {
    if (fallbackInput === undefined && fallbackOutput === undefined) return null;
    usage = {
      input_tokens: fallbackInput || 0,
      output_tokens: fallbackOutput || 0,
      total_tokens: (fallbackInput || 0) + (fallbackOutput || 0),
    };
  } else {
    if (!usage.input_tokens && fallbackInput) usage.input_tokens = fallbackInput;
    if (!usage.output_tokens && fallbackOutput) usage.output_tokens = fallbackOutput;
    usage.total_tokens = usage.input_tokens + usage.output_tokens;
  }
  return usage;
}

export function fallbackFrom(requestBytes, outputText) {
  return {
    inputTokens: estimateTokensFromBytes(requestBytes),
    outputTokens: estimateTokensFromText(outputText),
  };
}
