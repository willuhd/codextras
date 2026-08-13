import { randomUUID } from "node:crypto";

export function uuid() {
  return randomUUID().replaceAll("-", "");
}

export function newId(prefix) {
  return prefix + "_" + uuid();
}

export function messageItem(text) {
  return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}

export function sse(type, data, sequence) {
  const payload = { type: type, ...data };
  if (sequence !== undefined) payload.sequence_number = sequence;
  return "event: " + type + "\ndata: " + JSON.stringify(payload) + "\n\n";
}

export function sseDone() {
  return "data: [DONE]\n\n";
}

export const COMPACTION_PREFIX = "kcr1:";

export const SUMMARY_PREFIX =
  "Another language model started this task and produced a continuation summary. Use it to continue without repeating completed work:";

export const COMPACT_PROMPT =
  "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another language model that will resume the task.\n\n" +
  "Include current progress, key decisions, constraints, user preferences, remaining steps, and critical data or references. Be concise, structured, and focused on seamless continuation.";

export function encodeSummary(summary) {
  return COMPACTION_PREFIX + Buffer.from(summary, "utf8").toString("base64");
}

export function decodeSummary(value) {
  if (typeof value !== "string" || !value.startsWith(COMPACTION_PREFIX)) return undefined;
  try {
    return Buffer.from(value.slice(COMPACTION_PREFIX.length), "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

export function textOf(item) {
  if (!item || !Array.isArray(item.content)) return "";
  return item.content
    .map((part) => (part && typeof part.text === "string" ? part.text : ""))
    .join("");
}

export function reasoningItemText(item) {
  const summary = item && item.summary;
  if (typeof summary === "string" && summary) return summary;
  if (Array.isArray(summary)) {
    const text = summary
      .map((part) => (part && typeof part.text === "string" ? part.text : undefined))
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  const content = item && item.content;
  if (typeof content === "string" && content) return content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (part && typeof part.text === "string" ? part.text : undefined))
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  return undefined;
}

// Native OpenAI encrypted tokens are dense base64-ish blobs with no spaces.
// Routed handoffs are stored as readable plaintext; only those are inlinable.
export function isOpaqueToken(value) {
  return typeof value === "string" && value.length > 40 && !/\s/.test(value);
}

export function estimateTokensFromBytes(bytes) {
  return Math.max(1, Math.ceil(bytes / 4));
}

export function estimateTokensFromText(text) {
  const bytes = Buffer.byteLength(text || "", "utf8");
  return Math.max(0, Math.ceil(bytes / 4));
}
