// Native OpenAI passthrough: requests for models that are not declared in
// codextras.json are forwarded to the signed-in ChatGPT backend, exactly like
// codex-router does, so OpenAI models keep working alongside routed models.

const FORWARD_HEADERS = new Set([
  "authorization",
  "chatgpt-account-id",
  "openai-beta",
  "originator",
  "session_id",
  "session-id",
  "thread-id",
  "x-client-request-id",
  "x-codex-beta-features",
  "x-codex-installation-id",
  "x-codex-parent-thread-id",
  "x-codex-turn-metadata",
  "x-codex-turn-state",
  "x-codex-window-id",
  "x-oai-attestation",
  "x-openai-subagent",
  "x-responsesapi-include-timing-metrics",
]);

export function nativeBase() {
  return String(
    process.env.CODEXTRAS_NATIVE_BASE_URL ||
      "https://chatgpt.com/backend-api/codex",
  ).replace(/\/+$/, "");
}

export function nativeTarget(apiPath, search) {
  const withoutV1 = apiPath.replace(/^\/v1(?=\/|$)/, "");
  return nativeBase() + withoutV1 + (search || "");
}

export function forwardedHeaders(request) {
  const headers = {
    "Content-Type": "application/json",
    "Accept-Encoding": "identity",
  };
  for (const name of FORWARD_HEADERS) {
    const value = request.headers.get(name);
    if (value !== undefined && value !== null && value !== "") {
      headers[name] = value;
    }
  }
  return headers;
}

export async function forwardNative(request, apiPath, rawBody) {
  const url = new URL(request.url);
  const target = nativeTarget(apiPath, url.search);
  const body = rawBody !== undefined ? rawBody : undefined;
  let res;
  try {
    res = await fetch(target, {
      method: request.method,
      headers: forwardedHeaders(request),
      body: request.method === "GET" ? undefined : body,
      signal: request.signal,
    });
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    return Response.json({ error: { message } }, { status: 502 });
  }
  const responseHeaders = new Headers();
  const contentType = res.headers.get("content-type");
  if (contentType) responseHeaders.set("content-type", contentType);
  return new Response(res.body, { status: res.status, headers: responseHeaders });
}
