// Shared bridge for "custom" (freeform) tools such as exec. Chat-completions
// providers can only express function tools, so custom tools are advertised as
// functions with a single `content` string property; when the model calls one,
// the raw payload is recovered from that property and delivered to the host as
// a `custom_tool_call` item, which is the shape the app's tool router expects
// for freeform tools. Mirrors the proven LiteLLM bridge so the streaming and
// non-streaming response paths share one code path.

export function extractCustomToolNames(tools) {
  const names = new Set();
  if (!Array.isArray(tools)) return names;
  for (const tool of tools) {
    if (
      tool &&
      typeof tool === "object" &&
      tool.type === "custom" &&
      typeof tool.name === "string"
    ) {
      names.add(tool.name);
    }
  }
  return names;
}

const MAX_ARGUMENTS_LEN = 1_000_000;

export function unwrapCustomToolArguments(argumentsString) {
  if (!argumentsString) return "";
  if (argumentsString.length > MAX_ARGUMENTS_LEN) return argumentsString;
  try {
    const parsed = JSON.parse(argumentsString);
    if (parsed && typeof parsed === "object" && typeof parsed.content === "string") {
      return parsed.content;
    }
  } catch {
    // Not JSON; the raw arguments string is the input.
  }
  return argumentsString;
}

export function toolCallItem({ callId, name, args, status, customNames }) {
  const custom = customNames instanceof Set && customNames.has(name);
  const item = {
    id: callId,
    type: custom ? "custom_tool_call" : "function_call",
    status,
    call_id: callId,
    name,
  };
  if (custom) {
    item.input = status === "completed" ? unwrapCustomToolArguments(args) : "";
  } else {
    item.arguments = args;
  }
  return item;
}
