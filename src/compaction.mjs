import {
  COMPACT_PROMPT,
  SUMMARY_PREFIX,
  encodeSummary,
  messageItem,
  newId,
  sse,
  sseDone,
} from "./util.mjs";
import { buildMessages, buildResponsesInput, userMessageTexts } from "./convert/request.mjs";
import {
  buildChatBody,
  buildResponsesBody,
  chatUrl,
  isResponsesModel,
  providerHeaders,
  responsesUrl,
  supportsResponsesCustomTools,
} from "./adapter.mjs";
import { fallbackFrom, finalizeUsage } from "./usage.mjs";

function extractResponseText(json) {
  const message = json && json.choices && json.choices[0] && json.choices[0].message;
  if (message && typeof message.content === "string") return message.content;
  if (typeof json.output_text === "string") return json.output_text;
  let text = "";
  for (const item of Array.isArray(json && json.output) ? json.output : []) {
    for (const part of Array.isArray(item && item.content) ? item.content : []) {
      if (part && (part.type === "output_text" || part.type === "text") && typeof part.text === "string") {
        text += part.text;
      }
    }
  }
  return text;
}

export async function summarize({ payload, model, provider, requestBytes, signal }) {
  const isResponses = isResponsesModel(model, provider);
  let body;
  let url;
  if (isResponses) {
    const base = buildResponsesInput({
      input: Array.isArray(payload.input) ? payload.input : [],
      model,
      supportsCustomTools: supportsResponsesCustomTools(model, provider),
    });
    base.push({ type: "message", role: "user", content: [{ type: "input_text", text: COMPACT_PROMPT }] });
    body = buildResponsesBody({ payload, model, provider, input: base, tools: [], stream: false });
    url = responsesUrl(provider);
  } else {
    const messages = buildMessages({ input: payload.input || [], model });
    messages.push({ role: "user", content: [{ type: "text", text: COMPACT_PROMPT }] });
    body = buildChatBody({ payload, model, provider, messages, tools: [], stream: false });
    url = chatUrl(provider);
  }
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: providerHeaders(provider),
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    return { ok: false, status: 502, payload: { error: { message } } };
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      json && json.error && json.error.message
        ? json.error.message
        : "Upstream compaction failed with " + res.status;
    return { ok: false, status: res.status, payload: { error: { message } } };
  }
  const summary = extractResponseText(json).trim();
  if (!summary) {
    return {
      ok: false,
      status: 502,
      payload: { error: { message: "Compaction produced no summary." } },
    };
  }
  const usage = finalizeUsage(json.usage, fallbackFrom(requestBytes, summary));
  return { ok: true, summary, usage, input: payload.input || [] };
}

export function compactOutputV1(input, summary) {
  const budget = 80000;
  const selected = [];
  let remaining = budget;
  const texts = userMessageTexts(input);
  for (let i = texts.length - 1; i >= 0 && remaining > 0; i -= 1) {
    const value = texts[i];
    if (value.length <= remaining) {
      selected.push(value);
      remaining -= value.length;
    } else {
      selected.push(value.slice(value.length - remaining));
      break;
    }
  }
  selected.reverse();
  const summaryText = summary.trim()
    ? SUMMARY_PREFIX + "\n" + summary
    : "(no summary available)";
  return [...selected.map(messageItem), messageItem(summaryText)];
}

export function compactionSnapshot(model, item, status) {
  return {
    id: newId("resp"),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: status || "completed",
    model,
    output: item ? [item] : [],
    usage: null,
  };
}

export function writeCompactionSseEvents(model, summary) {
  const item = {
    type: "compaction",
    id: newId("cmp"),
    encrypted_content: encodeSummary(summary),
  };
  const created = compactionSnapshot(model, undefined, "in_progress");
  const completed = { ...created, status: "completed", output: [item] };
  let out = sse("response.created", { response: created }, 0);
  out += sse("response.output_item.done", { output_index: 0, item }, 1);
  out += sse("response.completed", { response: completed }, 2);
  out += sseDone();
  return out;
}
