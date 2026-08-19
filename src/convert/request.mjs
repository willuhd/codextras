import {
  SUMMARY_PREFIX,
  decodeSummary,
  isOpaqueToken,
  reasoningItemText,
} from "../util.mjs";
import { extractCustomToolNames } from "./tools.mjs";

export const COLLABORATION_NAMESPACE = "collaboration";
export const COLLABORATION_TOOL_DELIMITER = "__";
const STUB_TOOL_RESULT =
  "[tool result unavailable: prior tool execution was interrupted or omitted from history]";

export const COLLABORATION_TOOLS = new Set([
  "spawn_agent",
  "wait_agent",
  "send_message",
  "followup_task",
  "interrupt_agent",
  "list_agents",
]);

export function flatCollaborationName(name) {
  return flatNamespaceName(COLLABORATION_NAMESPACE, name);
}

export function flatNamespaceName(namespace, name) {
  return namespace + COLLABORATION_TOOL_DELIMITER + name;
}

export function splitFlatCollaborationName(name) {
  if (typeof name !== "string") return undefined;
  const prefix = COLLABORATION_NAMESPACE + COLLABORATION_TOOL_DELIMITER;
  if (!name.startsWith(prefix)) return undefined;
  const toolName = name.slice(prefix.length);
  return toolName ? toolName : undefined;
}

const CHAT_BUILTIN_TOOLS = new Set(["web_search", "web_search_2025_08_26"]);

// Flatten the tools the app sends into chat-completions shape. The conversion
// is purely shape- and type-based, never name-based: any tool with a string
// name (function/custom/mcp) becomes a chat function keeping that exact name;
// namespace tools flatten to `namespace__name` with the mapping recorded for
// round-tripping; chat-compatible builtins (web_search) pass through; anything
// else is dropped rather than forwarded.
export function flattenTools(tools) {
  const flat = [];
  const names = new Map();
  if (!Array.isArray(tools)) return { tools: flat, names };
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    if (tool.type === "namespace" && typeof tool.name === "string") {
      for (const fn of Array.isArray(tool.tools) ? tool.tools : []) {
        if (!fn || typeof fn.name !== "string") continue;
        const flatName = flatNamespaceName(tool.name, fn.name);
        flat.push({
          type: "function",
          function: {
            name: flatName,
            description: fn.description || "",
            parameters: fn.parameters || { type: "object", properties: {} },
          },
        });
        names.set(flatName, { namespace: tool.name, name: fn.name });
      }
      continue;
    }
    const name = tool.name;
    if (
      (tool.type === "function" || tool.type === "custom" || tool.type === "mcp") &&
      typeof name === "string"
    ) {
      // Custom (freeform) tools such as exec take raw text payloads. Chat
      // providers need an object schema, so a single required `content`
      // string property is advertised; the response bridge unwraps it back
      // into the raw input and delivers a custom_tool_call item.
      flat.push({
        type: "function",
        function: {
          name,
          description: tool.description || "",
          parameters:
            tool.parameters ||
            (tool.type === "custom"
              ? {
                  type: "object",
                  properties: {
                    content: {
                      type: "string",
                      description:
                        "The " + name + " content following the specified format",
                    },
                  },
                  required: ["content"],
                }
              : { type: "object", properties: {} }),
        },
      });
      continue;
    }
    if (
      tool.type === "function" &&
      tool.function &&
      typeof tool.function.name === "string"
    ) {
      flat.push(tool);
      continue;
    }
    if (typeof tool.type === "string" && CHAT_BUILTIN_TOOLS.has(tool.type)) {
      flat.push(tool);
    }
  }
  return { tools: flat, names, customNames: extractCustomToolNames(tools) };
}

// Responses tools are already native flat objects. Preserve every native
// definition (custom, MCP, web_search, computer, and future builtins) instead
// of converting it into a synthetic function. The only structural conversion
// is Codex namespace tools, because Responses has no namespace wrapper.
function customToolAsFunction(tool) {
  return {
    type: "function",
    name: tool.name,
    description: tool.description || "",
    parameters:
      tool.parameters || {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The " + tool.name + " content following the specified format",
          },
        },
        required: ["content"],
      },
  };
}

export function flattenToolsForResponses(tools, { supportsCustomTools = true } = {}) {
  const flat = [];
  const names = new Map();
  const customNames = extractCustomToolNames(tools);
  if (!Array.isArray(tools)) return { tools: flat, names, customNames };

  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || typeof tool.type !== "string") continue;
    if (tool.type === "namespace" && typeof tool.name === "string") {
      for (const fn of Array.isArray(tool.tools) ? tool.tools : []) {
        if (!fn || typeof fn.name !== "string") continue;
        const flatName = flatNamespaceName(tool.name, fn.name);
        flat.push({
          type: "function",
          name: flatName,
          description: fn.description || "",
          parameters: fn.parameters || { type: "object", properties: {} },
          ...(fn.strict === undefined ? {} : { strict: fn.strict }),
        });
        names.set(flatName, { namespace: tool.name, name: fn.name });
      }
      continue;
    }
    if (tool.type === "custom" && !supportsCustomTools) {
      flat.push(customToolAsFunction(tool));
      continue;
    }
    if (tool.type === "function" && tool.function && typeof tool.function.name === "string") {
      const converted = {
        ...tool,
        name: tool.function.name,
        description: tool.function.description || "",
        parameters: tool.function.parameters || { type: "object", properties: {} },
      };
      delete converted.function;
      flat.push(converted);
      continue;
    }
    // Function, custom, MCP, web search, and other Responses-native tools are
    // passed through unchanged when the provider advertises that wire type.
    flat.push(tool);
  }
  return { tools: flat, names, customNames };
}

function modelSupportsImages(model) {
  return Array.isArray(model.inputModalities) && model.inputModalities.includes("image");
}

function modelPassthroughImages(model) {
  return model.imagePassthrough !== false && modelSupportsImages(model);
}

const IMAGE_OMITTED_MARKER =
  "[image omitted: text-only model cannot consume image bytes]";

function dropToolOutputImages(output, model) {
  if (model.imagePassthrough !== false || !Array.isArray(output)) return output;
  const kept = [];
  let dropped = 0;
  for (const part of output) {
    if (
      part &&
      typeof part === "object" &&
      (part.type === "input_image" || part.image_url)
    ) {
      dropped += 1;
      continue;
    }
    kept.push(part);
  }
  if (!dropped) return output;
  kept.push({ type: "input_text", text: IMAGE_OMITTED_MARKER });
  return kept;
}

function partToChat(part, model) {
  if (!part || typeof part !== "object") return undefined;
  if (part.type === "input_text" || part.type === "output_text") {
    if (typeof part.text === "string") return { type: "text", text: part.text };
    return undefined;
  }
  if (part.type === "input_image") {
    const url = part.image_url;
    if (typeof url === "string" && url && modelPassthroughImages(model)) {
      return { type: "image_url", image_url: { url } };
    }
    // Models that cannot consume image bytes (imagePassthrough false or no
    // image modality) keep the <image ... path=...> tag Codex already placed
    // in the message text; the bytes are dropped here.
    return undefined;
  }
  if (part.type === "encrypted_content") {
    const value = part.encrypted_content;
    if (typeof value === "string" && !isOpaqueToken(value)) {
      return { type: "text", text: value };
    }
    return undefined;
  }
  return undefined;
}

function contentToChat(item, model) {
  const parts = [];
  for (const part of Array.isArray(item.content) ? item.content : []) {
    const converted = partToChat(part, model);
    if (converted) parts.push(converted);
  }
  return parts;
}

function messageRole(item) {
  const role = item.role;
  if (role === "developer") return "system";
  if (role === "system") return "system";
  if (role === "assistant") return "assistant";
  return "user";
}

function isOpaqueEncryptedContent(value) {
  return typeof value === "string" && value.length > 0 && !/\s/.test(value);
}

function agentMessageText(item) {
  const parts = [];
  for (const part of Array.isArray(item.content) ? item.content : []) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "input_text" && typeof part.text === "string") {
      parts.push(part.text);
    } else if (part.type === "encrypted_content") {
      const value = part.encrypted_content;
      if (typeof value === "string" && !isOpaqueEncryptedContent(value)) parts.push(value);
    }
  }
  return parts.join("\n");
}

// Toggle for the <thought> hack: DeepSeek needs visible thought blocks
// because its API discards reasoning_content from usable context; Responses
// models (Muse Spark) carry encrypted reasoning natively via include+store,
// so the visible hack can be disabled per-model with reasoningInjection:"none"
// or disableThoughtHack:true.
function shouldUseThoughtHack(model) {
  if (!model || typeof model !== "object") return true;
  if (model.reasoningInjection === false) return false;
  if (model.reasoningInjection === "none") return false;
  if (model.reasoningInjection === "encrypted") return false;
  if (model.disableThoughtHack === true) return false;
  if (model.thinkingHack === false) return false;
  return true;
}

// Reasoning that immediately precedes a tool call (or an empty assistant
// message announcing one) is carried as visible assistant text so the tool-call
// turn keeps a thinking thread the model can actually read. All reasoning is
// additionally attached as reasoning_content on the following assistant
// message, which DeepSeek requires when the request carries tools.
function shouldCarryReasoning(item, next) {
  if (!next) return false;
  if (next.type === "function_call") return true;
  if (next.type === "message" && next.role === "assistant") {
    const text = Array.isArray(next.content)
      ? next.content.map((p) => (p && typeof p.text === "string" ? p.text : "")).join("")
      : "";
    return text === "";
  }
  return false;
}

export function buildMessages({ input, model }) {
  const messages = [];
  const callIds = new Set();
  const seenOutputs = new Set();
  const items = Array.isArray(input) ? input : [];
  let pendingReasoning = "";
  let pendingVisible = "";
  const useThoughtHack = shouldUseThoughtHack(model);

  function attachReasoning(message) {
    if (!pendingReasoning) return;
    message.reasoning_content = message.reasoning_content
      ? message.reasoning_content + "\n\n" + pendingReasoning
      : pendingReasoning;
    pendingReasoning = "";
  }

  // The API discards reasoning_content from the model's usable context, so all
  // prior thinking is also re-injected as visible assistant text. The markers
  // keep it distinct from the model's public transcript so it reads as its own
  // private reasoning rather than words to echo back. `<think>` cannot be used:
  // the upstream's DeepSeek reasoning parser extracts that exact tag from
  // assistant content into the discarded reasoning channel.
  function flushVisible() {
    if (!pendingVisible) return;
    if (!useThoughtHack) {
      pendingVisible = "";
      return;
    }
    messages.push({
      role: "assistant",
      content: [{ type: "text", text: "<thought>\n" + pendingVisible + "\n</thought>" }],
    });
    pendingVisible = "";
  }

  function addToolCall(item) {
    let name = item.name;
    if (typeof item.namespace === "string" && typeof name === "string") {
      if (name.indexOf(COLLABORATION_TOOL_DELIMITER) === -1) {
        name = flatNamespaceName(item.namespace, name);
      }
    }
    const callId = item.call_id || item.id;
    let args;
    if (typeof item.input === "string") {
      // custom_tool_call items carry the raw payload in `input`; reconstruct
      // the chat arguments shape the upstream produced (content schema).
      args = JSON.stringify({ content: item.input });
    } else if (typeof item.arguments === "string") {
      args = item.arguments;
    } else {
      args = JSON.stringify(item.arguments ?? {});
    }
    const last = messages[messages.length - 1];
    if (last && last.role === "assistant") {
      attachReasoning(last);
      last.tool_calls = last.tool_calls || [];
      last.tool_calls.push({
        id: callId,
        type: "function",
        function: { name, arguments: args },
      });
    } else {
      const message = {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: callId, type: "function", function: { name, arguments: args } },
        ],
      };
      attachReasoning(message);
      messages.push(message);
    }
    callIds.add(callId);
  }

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item || typeof item !== "object") continue;
    if (item.type === "reasoning") {
      const text = reasoningItemText(item);
      if (!text) continue;
      pendingReasoning = pendingReasoning ? pendingReasoning + "\n\n" + text : text;
      if (shouldCarryReasoning(item, items[i + 1])) {
        flushVisible();
        const carried = useThoughtHack
          ? {
              role: "assistant",
              reasoning_content: pendingReasoning,
              content: [{ type: "text", text: "<thought>\n" + pendingReasoning + "\n</thought>" }],
            }
          : {
              role: "assistant",
              reasoning_content: pendingReasoning,
              content: null,
            };
        pendingReasoning = "";
        messages.push(carried);
      } else {
        pendingVisible = pendingVisible ? pendingVisible + "\n\n" + text : text;
      }
      continue;
    }
    flushVisible();
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      addToolCall(item);
      continue;
    }
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      const callId = item.call_id || item.id;
      if (!callId || !callIds.has(callId) || seenOutputs.has(callId)) continue;
      seenOutputs.add(callId);
      let output = dropToolOutputImages(item.output, model);
      if (output && typeof output === "object") output = JSON.stringify(output);
      if (typeof output !== "string") output = String(output ?? "");
      messages.push({ role: "tool", tool_call_id: callId, content: output });
      continue;
    }
    if (item.type === "message") {
      const role = messageRole(item);
      const parts = contentToChat(item, model);
      if (!parts.length) continue;
      const message = { role, content: parts };
      if (role === "assistant") attachReasoning(message);
      messages.push(message);
      continue;
    }
    if (item.type === "agent_message") {
      const text = agentMessageText(item);
      if (text) messages.push({ role: "user", content: [{ type: "text", text }] });
      continue;
    }
    if (item.type === "compaction" || item.type === "context_compaction") {
      const summary = decodeSummary(item.encrypted_content);
      const text = summary
        ? SUMMARY_PREFIX + "\n\n" + summary
        : "Earlier conversation history was compacted in an unreadable format.";
      messages.push({ role: "user", content: [{ type: "text", text }] });
      continue;
    }
    // web_search_call and other items have no chat representation; skip them.
  }

  flushVisible();

  if (pendingReasoning) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === "assistant") {
        attachReasoning(messages[i]);
        break;
      }
    }
  }

  return repairToolResults(messages);
}

function repairToolResults(messages) {
  const toolById = new Map();
  for (const message of messages) {
    if (message.role === "tool" && typeof message.tool_call_id === "string") {
      if (!toolById.has(message.tool_call_id)) {
        toolById.set(message.tool_call_id, message);
      }
    }
  }
  const emitted = new Set();
  const repaired = [];
  for (const message of messages) {
    if (message.role === "tool") {
      if (emitted.has(message.tool_call_id)) continue;
      if (toolById.get(message.tool_call_id) !== message) continue;
    }
    repaired.push(message);
    if (
      message.role !== "assistant" ||
      !message.tool_calls ||
      !message.tool_calls.length
    ) {
      continue;
    }
    for (const call of message.tool_calls) {
      const id = call.id;
      const toolMessage = toolById.get(id);
      if (toolMessage) {
        repaired.push(toolMessage);
        emitted.add(id);
      } else {
        repaired.push({ role: "tool", tool_call_id: id, content: STUB_TOOL_RESULT });
      }
    }
  }
  return repaired;
}

export function userMessageTexts(input) {
  const texts = [];
  for (const item of Array.isArray(input) ? input : []) {
    if (!item || item.type !== "message" || item.role !== "user") continue;
    for (const part of Array.isArray(item.content) ? item.content : []) {
      if (part && typeof part.text === "string" && part.text.trim()) texts.push(part.text);
    }
  }
  return texts;
}

// Responses input normalizer: Codex sends an enriched Responses journal
// (agent_message, compaction, reasoning with encrypted blobs, etc.) that is
// not valid for a raw upstream Responses call (Meta/Go validates strictly:
// `input[12] did not match any supported type`). This mirrors buildMessages
// but emits valid Responses items instead of Chat messages.
// assistant messages must use output_text, user/system/developer use input_text
// (Meta validates: `input_text is not valid on assistant messages`).
function partToResponses(part, model, role) {
  if (!part || typeof part !== "object") return undefined;
  const isAssistant = role === "assistant";
  if (part.type === "input_text" || part.type === "output_text") {
    if (typeof part.text === "string") return { type: isAssistant ? "output_text" : "input_text", text: part.text };
    return undefined;
  }
  if (part.type === "input_image") {
    const url = part.image_url;
    if (typeof url === "string" && url && modelPassthroughImages(model)) {
      return { type: "input_image", image_url: url };
    }
    return undefined;
  }
  if (part.type === "encrypted_content") {
    const v = part.encrypted_content;
    if (typeof v === "string" && !isOpaqueToken(v)) return { type: isAssistant ? "output_text" : "input_text", text: v };
    return undefined;
  }
  // Already Responses-shaped image_url form
  if (part.type === "image_url" && part.image_url && typeof part.image_url.url === "string") {
    if (modelPassthroughImages(model)) return { type: "input_image", image_url: part.image_url.url };
    return undefined;
  }
  return undefined;
}

function contentToResponses(item, model) {
  const role = item.role;
  const parts = [];
  for (const part of Array.isArray(item.content) ? item.content : []) {
    const conv = partToResponses(part, model, role);
    if (conv) parts.push(conv);
  }
  // Keep Codex's <image path> tag as text when bytes are dropped — it is
  // already an input_text part in the message, so the above preserves it.
  return parts;
}

export function buildResponsesInput({ input, model, supportsCustomTools = true }) {
  const out = [];
  const seenOutputs = new Set();
  const items = Array.isArray(input) ? input : [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "reasoning") {
      // Preserve encrypted reasoning verbatim for Muse (store:false + include)
      const hasSummary = Array.isArray(item.summary) || typeof item.summary === "string";
      const hasEncrypted = typeof item.encrypted_content === "string" && item.encrypted_content.length > 0;
      if (!hasSummary && !hasEncrypted) {
        const text = reasoningItemText(item);
        if (!text) continue;
        out.push({ type: "reasoning", id: item.id || undefined, summary: [{ type: "summary_text", text }] });
      } else {
        const r = { type: "reasoning" };
        if (item.id) r.id = item.id;
        if (Array.isArray(item.summary)) r.summary = item.summary;
        else if (typeof item.summary === "string") r.summary = [{ type: "summary_text", text: item.summary }];
        if (typeof item.encrypted_content === "string") r.encrypted_content = item.encrypted_content;
        // Content fallback
        if (!r.summary && item.content) {
          const t = reasoningItemText(item);
          if (t) r.summary = [{ type: "summary_text", text: t }];
        }
        out.push(r);
      }
      continue;
    }
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      // Responses has no namespace wrapper: replay namespaced Codex calls with
      // the same flat name used in the native tool definition.
      const call = { ...item };
      if (typeof call.namespace === "string" && typeof call.name === "string" && !call.name.includes(COLLABORATION_TOOL_DELIMITER)) {
        call.name = flatNamespaceName(call.namespace, call.name);
        delete call.namespace;
      }
      if (!supportsCustomTools && call.type === "custom_tool_call") {
        call.type = "function_call";
        call.arguments = JSON.stringify({ content: typeof call.input === "string" ? call.input : "" });
        delete call.input;
      }
      out.push(call);
      continue;
    }
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      const callId = item.call_id || item.id;
      if (!callId || seenOutputs.has(callId)) continue;
      seenOutputs.add(callId);
      let output = item.output;
      if (Array.isArray(output)) {
        const filtered = dropToolOutputImages(output, model);
        output = filtered;
        // Responses expects output as string, like Chat's tool message content.
        // Stringify array to preserve text, matching buildMessages behavior.
        if (Array.isArray(output)) {
          if (output.length === 0) output = "";
          else if (output.every((p) => p && typeof p.text === "string")) output = output.map((p) => p.text).join("\n");
          else output = JSON.stringify(output);
        }
      }
      if (output && typeof output === "object" && !Array.isArray(output)) output = JSON.stringify(output);
      if (typeof output !== "string") output = String(output ?? "");
      out.push({
        type: !supportsCustomTools && item.type === "custom_tool_call_output" ? "function_call_output" : item.type,
        call_id: callId,
        output,
      });
      continue;
    }
    if (item.type === "message") {
      const role = item.role === "developer" || item.role === "system" || item.role === "assistant" ? item.role : "user";
      const parts = contentToResponses(item, model);
      if (!parts.length) {
        // Keep at least the text if message was only an image tag that got stripped but original had <image ...> text
        const rawText = Array.isArray(item.content) ? item.content.map((p) => (p && typeof p.text === "string" ? p.text : "")).join("").trim() : "";
        if (rawText) {
          const t = role === "assistant" ? "output_text" : "input_text";
          out.push({ type: "message", role, content: [{ type: t, text: rawText }] });
        }
        continue;
      }
      out.push({ type: "message", role, content: parts });
      continue;
    }
    if (item.type === "agent_message") {
      const text = agentMessageText(item);
      if (text) out.push({ type: "message", role: "user", content: [{ type: "input_text", text }] });
      continue;
    }
    if (item.type === "compaction" || item.type === "context_compaction") {
      const summary = decodeSummary(item.encrypted_content);
      const text = summary ? SUMMARY_PREFIX + "\n\n" + summary : "Earlier conversation history was compacted in an unreadable format.";
      out.push({ type: "message", role: "user", content: [{ type: "input_text", text }] });
      continue;
    }
    // Valid Responses passthrough types that Go/Meta accept verbatim
    if (item.type === "web_search_call" || item.type === "reasoning" || item.type === "input_text" || item.type === "input_image") {
      out.push(item);
      continue;
    }
    // Drop unknown Codex-specific types (e.g. compaction_trigger is handled upstream as control)
    if (item.type === "compaction_trigger") continue;
  }
  return out;
}
