import { newId } from "../util.mjs";
import { fallbackFrom, finalizeUsage, usageFromPayload } from "../usage.mjs";
import { mapToolName } from "./stream.mjs";
import { toolCallItem } from "./tools.mjs";

function outputText(json) {
  const message = json.choices && json.choices[0] && json.choices[0].message;
  let text = "";
  if (message && typeof message.content === "string") text += message.content;
  if (message && typeof message.reasoning_content === "string") text += message.reasoning_content;
  for (const tc of Array.isArray(message && message.tool_calls) ? message.tool_calls : []) {
    if (tc && tc.function && typeof tc.function.arguments === "string") {
      text += tc.function.arguments;
    }
  }
  return text;
}

export function convertChatJsonToResponses({ json, requestedModel, requestBytes, toolNames, customNames }) {
  const names = toolNames instanceof Map ? toolNames : new Map();
  const custom = customNames instanceof Set ? customNames : new Set();
  const usage = finalizeUsage(
    usageFromPayload(json),
    fallbackFrom(requestBytes, outputText(json)),
  );
  const output = [];
  const message = json.choices && json.choices[0] && json.choices[0].message;
  if (message && typeof message.reasoning_content === "string" && message.reasoning_content) {
    output.push({
      type: "reasoning",
      id: newId("rs"),
      summary: [{ type: "summary_text", text: message.reasoning_content }],
    });
  }
  if (message && typeof message.content === "string" && message.content) {
    output.push({
      type: "message",
      id: newId("msg"),
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: message.content, annotations: [] }],
    });
  }
  for (const tc of Array.isArray(message && message.tool_calls) ? message.tool_calls : []) {
    if (!tc || !tc.id) continue;
    const fn = tc.function || {};
    const item = toolCallItem({
      callId: tc.id,
      name: typeof fn.name === "string" ? fn.name : "",
      args: typeof fn.arguments === "string" ? fn.arguments : "",
      status: "completed",
      customNames: custom,
    });
    const mapped = names.get(item.name) || mapToolName(item.name);
    if (mapped) {
      item.name = mapped.name;
      item.namespace = mapped.namespace;
    }
    output.push(item);
  }
  return {
    id: newId("resp"),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: requestedModel,
    output,
    usage,
    error: null,
  };
}
