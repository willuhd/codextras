import { loadConfig, loadSecret, findModel, providerFor } from "./config.mjs";
import { generateCatalog } from "./catalog.mjs";
import { buildChatBody, chatUrl, providerHeaders } from "./adapter.mjs";
import { buildMessages, flattenTools } from "./convert/request.mjs";
import { ChatStreamConverter } from "./convert/stream.mjs";
import { convertChatJsonToResponses } from "./convert/json.mjs";
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
