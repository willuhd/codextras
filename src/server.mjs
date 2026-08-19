import { loadConfig, loadSecret, findModel, providerFor } from "./config.mjs";
import { generateCatalog } from "./catalog.mjs";
import {
  buildChatBody,
  buildResponsesBody,
  chatUrl,
  isResponsesModel,
  providerHeaders,
  responsesUrl,
} from "./adapter.mjs";
import { buildMessages, flattenTools, flattenToolsForResponses } from "./convert/request.mjs";
import { ChatStreamConverter, mapToolName } from "./convert/stream.mjs";
import { convertChatJsonToResponses } from "./convert/json.mjs";
import { toolCallItem, unwrapCustomToolArguments } from "./convert/tools.mjs";
import {
  compactOutputV1,
  compactionSnapshot,
  summarize,
  writeCompactionSseEvents,
} from "./compaction.mjs";
import { encodeSummary, newId, sseDone } from "./util.mjs";
import { forwardNative } from "./native.mjs";
import { mergeCatalog } from "./catalog.mjs";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

function json(data, status) {
  return Response.json(data, { status: status || 200 });
}

function apiPathFrom(url, prefix, secret) {
  const pathname = url.pathname;
  if (pathname === "/health" || pathname === "/health/liveliness") return "health";
  const expected = prefix + "/";
  if (!pathname.startsWith(expected)) return undefined;
  const rest = pathname.slice(expected.length);
  const slash = rest.indexOf("/");
  if (slash < 0) return undefined;
  const token = rest.slice(0, slash);
  if (token !== secret) return undefined;
  return rest.slice(slash);
}

function guard(request) {
  if (request.headers.get("origin") || request.headers.get("sec-fetch-site")) return 403;
  if (request.method === "POST") {
    const type = String(request.headers.get("content-type") || "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (type !== "application/json") return 415;
  }
  return null;
}

async function* sseEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const data = block
        .split("\n")
        .map((line) => line.replace(/\r$/, ))
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data && data !== "[DONE]") {
        try {
          yield JSON.parse(data);
        } catch {
          // Ignore malformed SSE blocks; the stream continues.
        }
      }
    }
  }
  const data = buffer
    .split("\n")
    .map((line) => line.replace(/\r$/, ))
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (data && data !== "[DONE]") {
    try {
      yield JSON.parse(data);
    } catch {
      // Ignore malformed trailing block.
    }
  }
}

async function streamTurn(upstream, { model, requestBytes, toolNames, customNames }) {
  const converter = new ChatStreamConverter({
    requestedModel: model,
    requestBytes,
    toolNames,
    customNames,
  });
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(converter.initialEvents()));
      try {
        for await (const chunk of sseEvents(upstream.body)) {
          const events = converter.handleChunk(chunk);
          if (events) controller.enqueue(encoder.encode(events));
        }
      } catch {
        // Upstream aborted mid-stream; finalize what we have instead of hanging.
      }
      controller.enqueue(encoder.encode(converter.finish()));
      controller.enqueue(encoder.encode(sseDone()));
      controller.close();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

function mapResponsesItemForCodex(item, toolNames, customNames) {
  if (!item || typeof item !== "object") return item;
  const t = item.type;
  if (t !== "function_call" && t !== "custom_tool_call") return item;
  let name = item.name;
  let callId = item.call_id || item.id;
  let args = typeof item.arguments === "string" ? item.arguments : typeof item.input === "string" ? item.input : "";
  // If upstream returned flat name (collaboration__spawn_agent), map to namespaced for Codex
  const mapped = toolNames instanceof Map ? toolNames.get(name) : undefined;
  const fallback = !mapped ? mapToolName(name) : undefined;
  const target = mapped || fallback;
  if (target) {
    name = target.name;
    item = { ...item, name, namespace: target.namespace };
  }
  // Custom tools: Codex expects custom_tool_call with raw input, not function_call with JSON
  const isCustom = customNames instanceof Set && customNames.has(name);
  if (isCustom) {
    const raw = item.type === "custom_tool_call" ? item.input : unwrapCustomToolArguments(args);
    return {
      id: callId,
      type: "custom_tool_call",
      status: item.status || "completed",
      call_id: callId,
      name,
      input: raw,
    };
  }
  if (t === "custom_tool_call" && !isCustom) {
    // Upstream mistakenly returned custom for a non-custom tool — normalize to function_call
    return {
      id: callId,
      type: "function_call",
      status: item.status || "completed",
      call_id: callId,
      name,
      arguments: typeof item.input === "string" ? item.input : args,
      ...(item.namespace ? { namespace: item.namespace } : target ? { namespace: target.namespace } : {}),
    };
  }
  // Ensure function_call has arguments string
  if (isCustom) return item;
  return {
    ...item,
    name,
    arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
    ...(target && !item.namespace ? { namespace: target.namespace } : {}),
  };
}

function transformResponsesJsonForCodex(json, { toolNames, customNames, requestedModel, requestBytes }) {
  if (!json || typeof json !== "object") return json;
  json.model = requestedModel;
  if (Array.isArray(json.output)) {
    json.output = json.output.map((item) => {
      if (!item || typeof item !== "object") return item;
      if (item.type === "function_call" || item.type === "custom_tool_call") {
        return mapResponsesItemForCodex(item, toolNames, customNames);
      }
      // Some providers nest tool calls inside message content? Not for Responses.
      return item;
    });
  }
  if (!json.usage) {
    // Lazy fallback — caller will finalize if needed; keep shape for finalizeUsage
    json.usage = null;
  }
  return json;
}

async function streamResponsesTurn(upstream, { model, requestBytes, toolNames, customNames }) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  // We need to rewrite tool names on the fly while proxying raw SSE.
  // Responses SSE is `event: <type>\ndata: <json>\n\n` — we parse each block, map tool items, re-emit.
  const reader = upstream.body.getReader();
  let buffer = "";
  const stream = new ReadableStream({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            if (!block.trim()) continue;
            const lines = block.split("\n");
            let event = "";
            let data = "";
            for (const line of lines) {
              if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("data:")) data = line.slice(5).trimStart();
            }
            if (!data || data === "[DONE]") {
              if (data === "[DONE]") controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              continue;
            }
            let parsed;
            try {
              parsed = JSON.parse(data);
            } catch {
              controller.enqueue(encoder.encode(`event: ${event || "message"}\ndata: ${data}\n\n`));
              continue;
            }
            // Map tool call items in output_item events
            if (
              (event === "response.output_item.added" || event === "response.output_item.done") &&
              parsed.item &&
              (parsed.item.type === "function_call" || parsed.item.type === "custom_tool_call")
            ) {
              parsed.item = mapResponsesItemForCodex(parsed.item, toolNames, customNames);
              if (parsed.item.type === "function_call" && parsed.item.namespace) {
                // Codex expects namespaced function_call to carry namespace alongside name
                parsed.item.namespace = parsed.item.namespace;
              }
            }
            // Also handle response.completed's output array (some providers send it as event data)
            if (event === "response.completed" && parsed.response && Array.isArray(parsed.response.output)) {
              parsed.response.output = parsed.response.output.map((it) => mapResponsesItemForCodex(it, toolNames, customNames));
              parsed.response.model = model;
            }
            // Rewrite model in response.created/in_progress if present
            if ((event === "response.created" || event === "response.in_progress") && parsed.response) {
              parsed.response.model = model;
            }
            const outData = JSON.stringify(parsed);
            if (event) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${outData}\n\n`));
            else controller.enqueue(encoder.encode(`data: ${outData}\n\n`));
          }
        }
        // Flush remainder
        if (buffer.trim()) {
          const lines = buffer.split("\n");
          let event = "";
          let data = "";
          for (const line of lines) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data = line.slice(5).trimStart();
          }
          if (data && data !== "[DONE]") {
            try {
              let parsed = JSON.parse(data);
              if (parsed.item) parsed.item = mapResponsesItemForCodex(parsed.item, toolNames, customNames);
              controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(parsed)}\n\n`));
            } catch {
              controller.enqueue(encoder.encode(buffer));
            }
          }
        }
      } catch {
        // Upstream aborted — close gracefully
      }
      controller.enqueue(encoder.encode(sseDone()));
      controller.close();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

export function createServer(config, secret) {
  const prefix = config.gateway.pathPrefix;

  return Bun.serve({
    port: config.gateway.port,
    websocket: {
      open() {},
      message() {},
      close() {},
      drain() {},
    },
    async fetch(request) {
      const url = new URL(request.url);
      const apiPath = apiPathFrom(url, prefix, secret);
      if (apiPath === "health") {
        return json({ ok: true, service: "codextras" });
      }
      if (apiPath === undefined) {
        return json({ error: { message: "not found" } }, 404);
      }
      if ((request.headers.get("upgrade") || "").toLowerCase() === "websocket") {
        // Codex probes a WebSocket transport first and retries on 405; a 426
        // refusal makes it fall back to HTTP streaming immediately.
        return new Response(null, { status: 426, headers: { Connection: "close" } });
      }
      const blocked = guard(request);
      if (blocked) {
        const message =
          blocked === 403
            ? "Browser-originated requests are not accepted by codextras."
            : "codextras requests require Content-Type: application/json.";
        return json({ error: { message } }, blocked);
      }
      if (request.method === "GET" && apiPath === "/v1/models") {
        const merged = mergeCatalog(config);
        return json({
          object: "list",
          data: merged.models.map((m) => ({
            id: m.slug || m.alias,
            object: "model",
            owned_by: "codextras",
            display_name: m.display_name || m.displayName || m.slug,
          })),
        });
      }
      if (request.method !== "POST") {
        return json({ error: { message: "method not allowed" } }, 405);
      }
      const rawBody = await request.arrayBuffer().catch(() => new ArrayBuffer(0));
      let payload;
      try {
        payload = JSON.parse(new TextDecoder().decode(rawBody));
      } catch {
        payload = undefined;
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return json({ error: { message: "Request body must be a JSON object." } }, 400);
      }
      const inputs = Array.isArray(payload.input) ? payload.input : [];
      const compactionV2 =
        inputs.length > 0 && inputs[inputs.length - 1]?.type === "compaction_trigger";
      if (apiPath === "/v1/responses/compact" || compactionV2) {
        return handleCompaction(request, payload, apiPath, rawBody);
      }
      if (apiPath === "/v1/responses") {
        return handleTurn(request, payload, apiPath, rawBody);
      }
      return json({ error: { message: "unknown route " + apiPath } }, 404);
    },
  });
}

async function handleTurn(request, payload, apiPath, rawBody) {
  const model = findModel(payload.model, loadConfig());
  if (!model) {
    // Undeclared models are native OpenAI models: pass the request through.
    return forwardNative(request, apiPath, rawBody);
  }
  const config = loadConfig();
  const provider = providerFor(model, config);
  if (!provider) {
    return json({ error: { message: "No provider configured for " + model.alias } }, 500);
  }
  const isResponses = isResponsesModel(model, provider);
  if (isResponses) {
    const { tools, names, customNames } = flattenToolsForResponses(payload.tools);
    const input = Array.isArray(payload.input) ? payload.input : [];
    const stream = payload.stream !== false;
    const body = buildResponsesBody({ payload, model, provider, input, tools, stream });
    const requestBytes = Buffer.byteLength(JSON.stringify(body), "utf8");
    const url = responsesUrl(provider);
    const headers = providerHeaders(provider);
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: request.signal,
      });
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      return json({ error: { message } }, 502);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let message = "Upstream error " + res.status;
      try {
        const parsed = JSON.parse(text);
        if (parsed && parsed.error && parsed.error.message) message = parsed.error.message;
        else if (parsed && parsed.error) message = JSON.stringify(parsed.error);
        else if (text) message = text.slice(0, 500);
      } catch {
        if (text) message = text.slice(0, 500);
      }
      return json({ error: { message } }, res.status);
    }
    if (stream) {
      return streamResponsesTurn(res, {
        model: model.alias,
        requestBytes,
        toolNames: names,
        customNames,
      });
    }
    const upstreamJson = await res.json().catch(() => ({}));
    const mapped = transformResponsesJsonForCodex(upstreamJson, {
      toolNames: names,
      customNames,
      requestedModel: model.alias,
      requestBytes,
    });
    if (mapped && typeof mapped === "object" && !mapped.usage) {
      const { fallbackFrom, finalizeUsage } = await import("./usage.mjs");
      mapped.usage = finalizeUsage(undefined, fallbackFrom(requestBytes, JSON.stringify(mapped.output || "")));
    }
    return json(mapped);
  }
  const { tools, names, customNames } = flattenTools(payload.tools);
  const messages = buildMessages({ input: payload.input || [], model });
  if (typeof payload.instructions === "string" && payload.instructions.trim()) {
    messages.unshift({ role: "system", content: payload.instructions });
  }
  const stream = payload.stream !== false;
  const body = buildChatBody({ payload, model, provider, messages, tools, stream });
  const requestBytes = Buffer.byteLength(JSON.stringify(body), "utf8");
  const url = chatUrl(provider);
  const headers = providerHeaders(provider);
  const hasBuiltinTools =
    Array.isArray(body.tools) && body.tools.some((t) => t && t.type !== "function");
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: request.signal,
    });
    if (!res.ok && hasBuiltinTools) {
      // The upstream may not implement a builtin tool type; retry once
      // without it so the turn survives instead of dying on a serde error.
      const text = await res.text().catch(() => "");
      if (/unknown variant [`'"]?web_search/i.test(text)) {
        body.tools = body.tools.filter((t) => t && t.type === "function");
        res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: request.signal,
        });
      }
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    return json({ error: { message } }, 502);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = "Upstream error " + res.status;
    try {
      const parsed = JSON.parse(text);
      if (parsed && parsed.error && parsed.error.message) message = parsed.error.message;
    } catch {
      // Keep the generic message when the body is not JSON.
    }
    return json({ error: { message } }, res.status);
  }
  if (stream) {
    return streamTurn(res, {
      model: model.alias,
      requestBytes,
      toolNames: names,
      customNames,
    });
  }
  const upstreamJson = await res.json().catch(() => ({}));
  return json(
    convertChatJsonToResponses({
      json: upstreamJson,
      requestedModel: model.alias,
      requestBytes,
      toolNames: names,
      customNames,
    }),
  );
}

async function handleCompaction(request, payload, apiPath, rawBody) {
  const config = loadConfig();
  const model = findModel(payload.model, config);
  if (!model) {
    return forwardNative(request, apiPath, rawBody);
  }
  const provider = providerFor(model, config);
  if (!provider) {
    return json({ error: { message: "No provider configured for " + model.alias } }, 500);
  }
  const bodyForBytes = JSON.stringify({
    model: model.alias,
    input: payload.input || [],
  });
  const requestBytes = Buffer.byteLength(bodyForBytes, "utf8");
  const result = await summarize({
    payload,
    model,
    provider,
    requestBytes,
    signal: request.signal,
  });
  if (!result.ok) {
    return json(result.payload, result.status);
  }
  const inputs = Array.isArray(payload.input) ? payload.input : [];
  const compactionV2 =
    inputs.length > 0 && inputs[inputs.length - 1]?.type === "compaction_trigger";
  if (compactionV2) {
    if (payload.stream === false) {
      const item = {
        type: "compaction",
        id: newId("cmp"),
        encrypted_content: encodeSummary(result.summary),
      };
      return json(compactionSnapshot(payload.model, item));
    }
    return new Response(writeCompactionSseEvents(payload.model, result.summary), {
      headers: SSE_HEADERS,
    });
  }
  return json({ output: compactOutputV1(result.input, result.summary) });
}

export function catalogFor(config) {
  return generateCatalog(config.models);
}

if (import.meta.main) {
  const config = loadConfig();
  const secret = loadSecret();
  const server = createServer(config, secret);
  console.log(
    "codextras listening on http://127.0.0.1:" +
      server.port +
      config.gateway.pathPrefix +
      "/<secret>/v1",
  );
}
