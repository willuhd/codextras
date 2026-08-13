import { newId } from "../util.mjs";
import { fallbackFrom, finalizeUsage } from "../usage.mjs";
import { toolCallItem } from "./tools.mjs";
import {
  COLLABORATION_NAMESPACE,
  COLLABORATION_TOOL_DELIMITER,
  COLLABORATION_TOOLS,
} from "./request.mjs";

function splitFlatCollaborationName(name) {
  if (typeof name !== "string") return undefined;
  const prefix = COLLABORATION_NAMESPACE + COLLABORATION_TOOL_DELIMITER;
  if (!name.startsWith(prefix)) return undefined;
  const toolName = name.slice(prefix.length);
  return toolName ? toolName : undefined;
}

export function mapToolName(name) {
  if (typeof name !== "string") return undefined;
  const flat = splitFlatCollaborationName(name);
  if (flat) return { name: flat, namespace: COLLABORATION_NAMESPACE };
  if (COLLABORATION_TOOLS.has(name)) {
    return { name, namespace: COLLABORATION_NAMESPACE };
  }
  return undefined;
}

export class ChatStreamConverter {
  constructor({ requestedModel, requestBytes, toolNames, customNames }) {
    this.requestedModel = requestedModel;
    this.requestBytes = requestBytes || 0;
    this.toolNames = toolNames instanceof Map ? toolNames : new Map();
    this.customNames = customNames instanceof Set ? customNames : new Set();
    this.seq = 0;
    this.responseId = newId("resp");
    this.createdAt = Math.floor(Date.now() / 1000);
    this.reasoning = null;
    this.message = null;
    this.tools = new Map();
    this.toolIndexId = new Map();
    this.nextToolIndex = 1;
    this.reasoningOutput = [];
    this.messageOutput = [];
    this.toolOutput = [];
    this.usage = undefined;
    this.finished = false;
  }

  sse(type, data) {
    this.seq += 1;
    return (
      "event: " + type +
      "\ndata: " + JSON.stringify({ type, sequence_number: this.seq, ...data }) + "\n\n"
    );
  }

  initialEvents() {
    const snapshot = {
      id: this.responseId,
      object: "response",
      created_at: this.createdAt,
      status: "in_progress",
      model: this.requestedModel,
      output: [],
      usage: null,
      error: null,
    };
    let out = this.sse("response.created", { response: snapshot });
    out += this.sse("response.in_progress", { response: snapshot });
    return out;
  }

  handleChunk(chunk) {
    const choices = chunk && chunk.choices;
    if (!choices || !choices.length) {
      if (chunk && chunk.usage) this.usage = chunk.usage;
      return "";
    }
    const choice = choices[0];
    const delta = choice.delta || {};
    let out = "";
    const reasoningDelta = delta.reasoning_content;
    if (typeof reasoningDelta === "string" && reasoningDelta) {
      out += this.reasoningDelta(reasoningDelta);
    }
    const contentDelta = delta.content;
    if (typeof contentDelta === "string" && contentDelta) {
      out += this.flushReasoning();
      out += this.messageDelta(contentDelta);
    }
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
      out += this.flushReasoning();
      out += this.toolDeltas(delta.tool_calls);
    }
    if (chunk && chunk.usage) this.usage = chunk.usage;
    return out;
  }

  reasoningDelta(delta) {
    if (!this.reasoning) {
      const id = newId("rs");
      this.reasoning = { id, text: "" };
      let out = this.sse("response.output_item.added", {
        output_index: 0,
        item: { id, type: "reasoning", status: "in_progress", summary: [] },
      });
      out += this.sse("response.reasoning_summary_text.delta", {
        item_id: id,
        output_index: 0,
        delta,
      });
      this.reasoning.text += delta;
      return out;
    }
    this.reasoning.text += delta;
    return this.sse("response.reasoning_summary_text.delta", {
      item_id: this.reasoning.id,
      output_index: 0,
      delta,
    });
  }

  flushReasoning() {
    if (!this.reasoning) return "";
    const r = this.reasoning;
    this.reasoning = null;
    let out = this.sse("response.reasoning_summary_text.done", {
      item_id: r.id,
      output_index: 0,
      summary_index: 0,
      text: r.text,
    });
    out += this.sse("response.reasoning_summary_part.done", {
      item_id: r.id,
      output_index: 0,
      summary_index: 0,
      part: { type: "summary_text", text: r.text },
    });
    out += this.sse("response.output_item.done", {
      output_index: 0,
      item: { id: r.id, type: "reasoning", summary: [{ type: "summary_text", text: r.text }] },
    });
    this.reasoningOutput.push({
      id: r.id,
      type: "reasoning",
      summary: [{ type: "summary_text", text: r.text }],
    });
    return out;
  }

  messageDelta(delta) {
    if (!this.message) {
      const id = newId("msg");
      this.message = { id, text: "" };
      let out = this.sse("response.output_item.added", {
        output_index: 0,
        item: { id, type: "message", role: "assistant", status: "in_progress", content: [] },
      });
      out += this.sse("response.content_part.added", {
        item_id: id,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
      out += this.sse("response.output_text.delta", {
        item_id: id,
        output_index: 0,
        content_index: 0,
        delta,
      });
      this.message.text += delta;
      return out;
    }
    this.message.text += delta;
    return this.sse("response.output_text.delta", {
      item_id: this.message.id,
      output_index: 0,
      content_index: 0,
      delta,
    });
  }

  flushMessage() {
    if (!this.message) return "";
    const m = this.message;
    this.message = null;
    let out = this.sse("response.output_text.done", {
      item_id: m.id,
      output_index: 0,
      content_index: 0,
      text: m.text,
    });
    out += this.sse("response.content_part.done", {
      item_id: m.id,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: m.text, annotations: [] },
    });
    const item = {
      id: m.id,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: m.text, annotations: [] }],
    };
    out += this.sse("response.output_item.done", { output_index: 0, item });
    this.messageOutput.push(item);
    return out;
  }

  toolDeltas(toolCalls) {
    let out = "";
    for (const tc of toolCalls) {
      if (!tc || typeof tc !== "object") continue;
      let callId = tc.id;
      if (!callId && typeof tc.index === "number") {
        callId = this.toolIndexId.get(tc.index);
      }
      if (!callId) continue;
      if (typeof tc.index === "number") this.toolIndexId.set(tc.index, callId);
      const fn = tc.function || {};
      let entry = this.tools.get(callId);
      if (!entry) {
        entry = {
          id: callId,
          name: typeof fn.name === "string" ? fn.name : "",
          args: "",
          outputIndex: this.nextToolIndex,
          done: false,
        };
        this.nextToolIndex += 1;
        this.tools.set(callId, entry);
        out += this.sse("response.output_item.added", {
          output_index: entry.outputIndex,
          item: toolCallItem({
            callId,
            name: entry.name,
            args: "",
            status: "in_progress",
            customNames: this.customNames,
          }),
        });
      } else if (typeof fn.name === "string" && fn.name && !entry.name) {
        entry.name = fn.name;
      }
      const argsDelta = typeof fn.arguments === "string" ? fn.arguments : "";
      if (argsDelta) {
        entry.args += argsDelta;
        for (let i = 0; i < argsDelta.length; i += 10) {
          out += this.sse("response.function_call_arguments.delta", {
            item_id: callId,
            output_index: entry.outputIndex,
            delta: argsDelta.slice(i, i + 10),
          });
        }
      }
    }
    return out;
  }

  flushTools() {
    let out = "";
    for (const entry of this.tools.values()) {
      if (entry.done) continue;
      entry.done = true;
      out += this.sse("response.function_call_arguments.done", {
        item_id: entry.id,
        output_index: entry.outputIndex,
        arguments: entry.args,
      });
      const item = toolCallItem({
        callId: entry.id,
        name: entry.name,
        args: entry.args,
        status: "completed",
        customNames: this.customNames,
      });
      const mapped = this.toolNames.get(item.name) || mapToolName(item.name);
      if (mapped) {
        item.name = mapped.name;
        item.namespace = mapped.namespace;
      }
      out += this.sse("response.output_item.done", { output_index: entry.outputIndex, item });
      this.toolOutput.push(item);
    }
    return out;
  }

  totalOutputText() {
    let text = "";
    if (this.reasoning) text += this.reasoning.text;
    if (this.message) text += this.message.text;
    for (const entry of this.tools.values()) text += entry.args;
    return text;
  }

  finish() {
    if (this.finished) return "";
    this.finished = true;
    let out = this.flushReasoning();
    out += this.flushTools();
    out += this.flushMessage();
    const usage = finalizeUsage(
      this.usage,
      fallbackFrom(this.requestBytes, this.totalOutputText()),
    );
    const output = [
      ...this.reasoningOutput,
      ...this.messageOutput,
      ...this.toolOutput,
    ];
    const response = {
      id: this.responseId,
      object: "response",
      created_at: this.createdAt,
      status: "completed",
      model: this.requestedModel,
      output,
      usage,
      error: null,
    };
    out += this.sse("response.completed", { response });
    return out;
  }
}
