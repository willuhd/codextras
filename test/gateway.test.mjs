import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMockProvider } from "../smoke/mock-provider.mjs";

let mock;
let nativeMock;
let server;
let base;
let secret = "testsecret123";

beforeAll(async () => {
  mock = createMockProvider();
  nativeMock = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const auth = request.headers.get("authorization") ? "yes" : "no";
      const body = await request.json().catch(() => ({}));
      return Response.json({
        id: "resp_native",
        object: "response",
        status: "completed",
        model: body.model,
        output: [
          {
            type: "message",
            id: "msg_native",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "native:" + url.pathname + ";auth=" + auth + ";model=" + body.model,
                annotations: [],
              },
            ],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    },
  });
  process.env.CODEXTRAS_NATIVE_BASE_URL = "http://127.0.0.1:" + nativeMock.port;
  const dir = mkdtempSync(path.join(tmpdir(), "codextras-test-"));
  const configPath = path.join(dir, "codextras.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        gateway: { port: 0, pathPrefix: "/_codextras" },
        providers: [
          {
            id: "mock",
            type: "openai-chat",
            baseUrl: "http://127.0.0.1:" + mock.port,
            apiKeyEnv: "CODEXTRAS_TEST_KEY",
            quirks: { efforts: { low: "low", high: "high", max: "max" } },
          },
        ],
        models: [
          {
            alias: "test-model",
            displayName: "Test Model",
            provider: "mock",
            upstreamModel: "mock-upstream",
            contextWindow: 100000,
            efforts: ["low", "high", "max"],
            defaultEffort: "high",
            inputModalities: ["text", "image"],
            reasoningContent: true,
          },
          {
            alias: "text-model",
            displayName: "Text Model",
            provider: "mock",
            upstreamModel: "mock-upstream",
            contextWindow: 100000,
            efforts: ["high"],
            defaultEffort: "high",
            inputModalities: ["text"],
            reasoningContent: true,
          },
        ],
      },
      null,
      2,
    ),
  );
  process.env.CODEXTRAS_TEST_KEY = "sk-test";
  process.env.CODEXTRAS_CONFIG = configPath;
  const { createServer } = await import("../src/server.mjs");
  const { loadConfig } = await import("../src/config.mjs");
  server = createServer(loadConfig(), secret);
  base = "http://127.0.0.1:" + server.port + "/_codextras/" + secret;
});

afterAll(() => {
  if (server) server.stop(true);
  if (mock) mock.stop(true);
  if (nativeMock) nativeMock.stop(true);
  delete process.env.CODEXTRAS_NATIVE_BASE_URL;
});

function user(text) {
  return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}

test("non-stream turn: effort, reasoning, usage, tool items", async () => {
  const res = await fetch(base + "/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "test-model",
      instructions: "Be brief.",
      input: [user("hi")],
      reasoning: { effort: "max" },
      stream: false,
    }),
  });
  expect(res.status).toBe(200);
  const data = await res.json();
  const messageItem = data.output.find((i) => i.type === "message");
  expect(messageItem.content[0].text).toContain("effort=max");
  const reasoningItem = data.output.find((i) => i.type === "reasoning");
  expect(reasoningItem.summary[0].text).toContain("mock reasoning");
  const toolItems = data.output.filter((i) => i.type === "function_call");
  expect(toolItems.length).toBe(2);
  expect(toolItems[0].name).toBe("shell");
  expect(toolItems[1].name).toBe("spawn_agent");
  expect(toolItems[1].namespace).toBe("collaboration");
  expect(data.usage.total_tokens).toBe(55);
});

test("stream turn: reasoning + text + tool SSE events and completed usage", async () => {
  const res = await fetch(base + "/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "test-model",
      input: [user("stream please")],
      reasoning: { effort: "max" },
      stream: true,
    }),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const text = await res.text();
  expect(text).toContain("event: response.created");
  expect(text).toContain("event: response.output_item.added");
  expect(text).toContain("event: response.reasoning_summary_text.delta");
  expect(text).toContain("event: response.reasoning_summary_text.done");
  expect(text).toContain("event: response.output_text.delta");
  expect(text).toContain("event: response.function_call_arguments.delta");
  expect(text).toContain("event: response.function_call_arguments.done");
  expect(text).toContain("event: response.output_item.done");
  expect(text).toContain("event: response.completed");
  expect(text.endsWith("data: [DONE]\n\n")).toBe(true);

  const completedLine = text
    .split("\n\n")
    .find((block) => block.startsWith("event: response.completed"));
  const data = JSON.parse(completedLine.slice(completedLine.indexOf("\n") + 1).replace(/^data: /, ""));
  const items = data.response.output;
  expect(items.find((i) => i.type === "reasoning").summary[0].text).toContain("mock reasoning");
  expect(items.find((i) => i.type === "message").content[0].text).toContain("effort=max");
  expect(items.find((i) => i.type === "function_call" && i.name === "spawn_agent").namespace).toBe("collaboration");
  expect(data.response.usage.total_tokens).toBe(55);
});

test("reasoning carry: trace rides with the tool-call assistant message", async () => {
  const res = await fetch(base + "/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "test-model",
      input: [
        {
          type: "reasoning",
          id: "rs_1",
          summary: [{ type: "summary_text", text: "CARRIED_TRACE thinking text" }],
        },
        { type: "function_call", id: "fc1", call_id: "call_9", name: "shell", arguments: "{}" },
        { type: "function_call_output", id: "o1", call_id: "call_9", output: "ok" },
        user("continue"),
      ],
      stream: false,
    }),
  });
  expect(res.status).toBe(200);
  const data = await res.json();
  const messageItem = data.output.find((i) => i.type === "message");
  expect(messageItem.content[0].text).toContain("carried=true");
});

test("images: bytes dropped for text-only model, kept for multimodal", async () => {
  const input = [
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "look at this" },
        { type: "input_image", image_url: "data:image/png;base64,AAAA" },
      ],
    },
  ];
  const textRes = await fetch(base + "/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "text-model", input, stream: false }),
  });
  const textData = await textRes.json();
  expect(
    textData.output.find((i) => i.type === "message").content[0].text,
  ).toContain("hasImage=false");

  const imageRes = await fetch(base + "/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "test-model", input, stream: false }),
  });
  const imageData = await imageRes.json();
  expect(
    imageData.output.find((i) => i.type === "message").content[0].text,
  ).toContain("hasImage=true");
});

test("compaction v1 returns tail history plus summary", async () => {
  const res = await fetch(base + "/v1/responses/compact", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "test-model",
      input: [user("hello world")],
    }),
  });
  expect(res.status).toBe(200);
  const data = await res.json();
  const last = data.output[data.output.length - 1];
  expect(last.type).toBe("message");
  expect(last.content[0].text).toContain("continuation summary");
  expect(last.content[0].text).toContain("mock answer");
});

test("compaction v2 trigger returns a compaction item with kcr1 envelope", async () => {
  const res = await fetch(base + "/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "test-model",
      input: [user("old history"), { type: "compaction_trigger" }],
      stream: false,
    }),
  });
  expect(res.status).toBe(200);
  const data = await res.json();
  expect(data.output[0].type).toBe("compaction");
  expect(data.output[0].encrypted_content.startsWith("kcr1:")).toBe(true);
});

test("undeclared model routes to native passthrough", async () => {
  const res = await fetch(base + "/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer native-token" },
    body: JSON.stringify({
      model: "gpt-5.6-sol",
      input: [user("hi")],
      stream: false,
    }),
  });
  expect(res.status).toBe(200);
  const data = await res.json();
  const text = data.output.find((i) => i.type === "message").content[0].text;
  expect(text).toContain("native:/responses");
  expect(text).toContain("auth=yes");
  expect(text).toContain("model=gpt-5.6-sol");
});

test("native compaction passthrough for undeclared models", async () => {
  const res = await fetch(base + "/v1/responses/compact", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.6-sol",
      input: [user("hi")],
    }),
  });
  expect(res.status).toBe(200);
  const data = await res.json();
  const text = data.output.find((i) => i.type === "message").content[0].text;
  expect(text).toContain("native:/responses/compact");
});

test("merged catalog: native models plus declared, aliases win", async () => {
  const nativePath = path.join(
    mkdtempSync(path.join(tmpdir(), "codextras-native-")),
    "native.json",
  );
  writeFileSync(
    nativePath,
    JSON.stringify({
      models: [
        {
          slug: "gpt-5.6-sol",
          display_name: "GPT-5.6 Sol",
          visibility: "list",
          priority: 1,
          supported_in_api: true,
        },
        {
          slug: "test-model",
          display_name: "NATIVE COLLISION",
          visibility: "list",
          priority: 1,
          supported_in_api: true,
        },
      ],
    }),
  );
  process.env.CODEXTRAS_NATIVE_CATALOG = nativePath;
  const { loadConfig } = await import("../src/config.mjs");
  const { mergeCatalog, captureNativeCatalog } = await import("../src/catalog.mjs");
  const merged = mergeCatalog(loadConfig(), captureNativeCatalog());
  const slugs = merged.models.map((m) => m.slug);
  expect(slugs).toContain("gpt-5.6-sol");
  expect(slugs).toContain("test-model");
  const declared = merged.models.find((m) => m.slug === "test-model");
  expect(declared.display_name).toBe("Test Model");
  delete process.env.CODEXTRAS_NATIVE_CATALOG;
});

test("agent handoff and compaction history decode in request conversion", async () => {
  const { buildMessages } = await import("../src/convert/request.mjs");
  const model = { inputModalities: ["text"] };
  const messages = buildMessages({
    model,
    input: [
      {
        type: "agent_message",
        id: "am1",
        content: [
          { type: "encrypted_content", encrypted_content: "plaintext handoff payload" },
        ],
      },
      {
        type: "compaction",
        id: "c1",
        encrypted_content:
          "kcr1:" + Buffer.from("compacted summary here").toString("base64"),
      },
      {
        type: "reasoning",
        id: "r1",
        summary: [{ type: "summary_text", text: "trace A" }],
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] },
    ],
  });
  const text = JSON.stringify(messages);
  expect(text).toContain("plaintext handoff payload");
  expect(text).toContain("continuation summary");
  expect(text).toContain("compacted summary here");
  expect(text).toContain("<thought>");
  expect(text).toContain("trace A");
  expect(text).toContain("reasoning_content");
});

test("tool results are reordered to follow their tool_calls when interleaved", async () => {
  const { buildMessages } = await import("../src/convert/request.mjs");
  const messages = buildMessages({
    model: { inputModalities: ["text"] },
    input: [
      { type: "reasoning", summary: [{ type: "summary_text", text: "plan A" }] },
      { type: "function_call", call_id: "call_D", name: "shell", arguments: "{}" },
      { type: "function_call", call_id: "call_E", name: "exec", arguments: "{}" },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "probing" }],
      },
      { type: "function_call_output", call_id: "call_D", output: "d-out" },
      { type: "function_call_output", call_id: "call_E", output: "e-out" },
    ],
  });
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i].role !== "tool") continue;
    let j = i - 1;
    while (j >= 0 && messages[j].role === "tool") j -= 1;
    const prev = messages[j];
    expect(prev && prev.role).toBe("assistant");
    expect(Array.isArray(prev.tool_calls) ? prev.tool_calls.map((c) => c.id) : []).toContain(
      messages[i].tool_call_id,
    );
  }
  const ids = messages
    .filter((m) => m.role === "tool")
    .map((m) => m.tool_call_id)
    .sort();
  expect(ids).toEqual(["call_D", "call_E"]);
});

test("imagePassthrough false drops image bytes but keeps text tags", async () => {
  const { buildMessages } = await import("../src/convert/request.mjs");
  const messages = buildMessages({
    model: { inputModalities: ["text", "image"], imagePassthrough: false },
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: '<image name="[Image #1]" path="/tmp/x.png">' },
          { type: "input_image", image_url: "data:image/png;base64,AAAA" },
        ],
      },
    ],
  });
  const text = JSON.stringify(messages);
  expect(text).not.toContain("image_url");
  expect(text).not.toContain("base64");
  expect(text).toContain("/tmp/x.png");
});

test("image parts pass through when passthrough is enabled", async () => {
  const { buildMessages } = await import("../src/convert/request.mjs");
  const messages = buildMessages({
    model: { inputModalities: ["text", "image"] },
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }],
      },
    ],
  });
  expect(JSON.stringify(messages)).toContain("image_url");
});

test("imagePassthrough false replaces tool-output image bytes with marker", async () => {
  const { buildMessages } = await import("../src/convert/request.mjs");
  const messages = buildMessages({
    model: { inputModalities: ["text", "image"], imagePassthrough: false },
    input: [
      { type: "function_call", call_id: "c1", name: "view_image", arguments: "{}" },
      {
        type: "function_call_output",
        call_id: "c1",
        output: [{ type: "input_image", image_url: "data:image/png;base64,BBBB" }],
      },
    ],
  });
  const text = JSON.stringify(messages);
  expect(text).not.toContain("BBBB");
  expect(text).toContain("image omitted");
});

test("websocket upgrades are refused with 426", async () => {
  const { connect } = await import("node:net");
  const response = await new Promise((resolve, reject) => {
    const sock = connect(server.port, "127.0.0.1", () => {
      sock.write(
        "GET /_codextras/" +
          secret +
          "/v1/responses HTTP/1.1\r\n" +
          "Host: 127.0.0.1\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
          "Sec-WebSocket-Version: 13\r\n\r\n",
      );
    });
    sock.on("data", (chunk) => {
      sock.destroy();
      resolve(String(chunk));
    });
    sock.on("error", reject);
    setTimeout(() => reject(new Error("no response to upgrade handshake")), 3000);
  });
  expect(response).toContain("426");
});

test("responses-format and mcp tools are flattened with names preserved", async () => {
  const { flattenTools } = await import("../src/convert/request.mjs");
  const { tools, names } = flattenTools([
    { type: "function", name: "shell", description: "Run a command", parameters: { type: "object" } },
    { type: "function", name: "tools.mcp__exa__search", description: "Exa", parameters: { type: "object" } },
    { type: "mcp", name: "mcp__other__tool", description: "Other", parameters: { type: "object" } },
    { type: "function", function: { name: "legacy", description: "", parameters: {} } },
    { type: "namespace", name: "collaboration", tools: [{ name: "spawn_agent", description: "x", parameters: { type: "object" } }] },
  ]);
  const chat = tools.map((t) => t.function.name);
  expect(chat).toEqual([
    "shell",
    "tools.mcp__exa__search",
    "mcp__other__tool",
    "legacy",
    "collaboration__spawn_agent",
  ]);
  expect(tools[0].function.description).toBe("Run a command");
  expect(names.get("collaboration__spawn_agent")).toEqual({
    namespace: "collaboration",
    name: "spawn_agent",
  });
});

test("custom tools and builtins flatten generically; namespaces round-trip", async () => {
  const { flattenTools } = await import("../src/convert/request.mjs");
  const { tools, names, customNames } = flattenTools([
    { type: "custom", name: "exec", description: "Run JS" },
    { type: "web_search", external_web_access: true },
    { type: "function", name: "apply_patch", description: "Patch", parameters: { type: "object" } },
    { type: "namespace", name: "functions", tools: [{ name: "shell", description: "s", parameters: { type: "object" } }] },
    { type: "computer", name: "cua" },
  ]);
  const chat = tools.map((t) => (t.function ? t.function.name : t.type));
  expect(chat).toEqual(["exec", "web_search", "apply_patch", "functions__shell"]);
  expect(names.get("functions__shell")).toEqual({ namespace: "functions", name: "shell" });
  expect(tools[0].function.description).toBe("Run JS");
  expect(tools[0].function.parameters).toEqual({
    type: "object",
    properties: {
      content: { type: "string", description: "The exec content following the specified format" },
    },
    required: ["content"],
  });
  expect([...customNames]).toEqual(["exec"]);
});

test("custom tool calls are unwrapped and emitted as custom_tool_call items", async () => {
  const { unwrapCustomToolArguments, toolCallItem } = await import("../src/convert/tools.mjs");
  expect(unwrapCustomToolArguments('{"content": "console.log(1)"}')).toBe("console.log(1)");
  expect(unwrapCustomToolArguments("not json")).toBe("not json");
  expect(unwrapCustomToolArguments('{"other": 1}')).toBe('{"other": 1}');

  const custom = toolCallItem({
    callId: "c1",
    name: "exec",
    args: '{"content": "const r = await tools.exec_command({cmd: 1})"}',
    status: "completed",
    customNames: new Set(["exec"]),
  });
  expect(custom.type).toBe("custom_tool_call");
  expect(custom.input).toBe("const r = await tools.exec_command({cmd: 1})");
  expect(custom.arguments).toBeUndefined();

  const customPending = toolCallItem({
    callId: "c1",
    name: "exec",
    args: "",
    status: "in_progress",
    customNames: new Set(["exec"]),
  });
  expect(customPending.type).toBe("custom_tool_call");
  expect(customPending.input).toBe("");

  const fn = toolCallItem({
    callId: "c2",
    name: "wait",
    args: "{}",
    status: "completed",
    customNames: new Set(["exec"]),
  });
  expect(fn.type).toBe("function_call");
  expect(fn.arguments).toBe("{}");
  expect(fn.input).toBeUndefined();
});

test("streaming converter emits custom_tool_call items for custom tools", async () => {
  const { ChatStreamConverter } = await import("../src/convert/stream.mjs");
  const converter = new ChatStreamConverter({
    requestedModel: "deepseek-flash",
    customNames: new Set(["exec"]),
  });
  let out = converter.initialEvents();
  out += converter.handleChunk({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "exec", arguments: '{"content":"console.log(1)"}' },
            },
            {
              index: 1,
              id: "call_2",
              type: "function",
              function: { name: "wait", arguments: "{}" },
            },
          ],
        },
      },
    ],
  });
  out += converter.finish();
  expect(out).toContain('"type":"custom_tool_call"');
  expect(out).toContain('"input":"console.log(1)"');
  expect(out).toContain('"type":"function_call"');
  expect(out).toContain('"name":"wait"');
});

test("non-streaming converter emits custom_tool_call items for custom tools", async () => {
  const { convertChatJsonToResponses } = await import("../src/convert/json.mjs");
  const response = convertChatJsonToResponses({
    json: {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "exec", arguments: '{"content":"text(\\"hi\\")"}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
    requestedModel: "deepseek-flash",
    customNames: new Set(["exec"]),
  });
  const item = response.output.find((o) => o.type === "custom_tool_call");
  expect(item).toBeDefined();
  expect(item.name).toBe("exec");
  expect(item.input).toBe('text("hi")');
});

test("reasoning is carried visibly in think markers and attached as reasoning_content", async () => {
  const { buildMessages } = await import("../src/convert/request.mjs");
  const messages = buildMessages({
    model: { inputModalities: ["text"] },
    input: [
      { type: "reasoning", summary: [{ type: "summary_text", text: "think one" }] },
      { type: "reasoning", summary: [{ type: "summary_text", text: "think two" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
    ],
  });
  expect(messages[0].role).toBe("assistant");
  expect(messages[0].content).toEqual([
    { type: "text", text: "<thought>\nthink one\n\nthink two\n</thought>" },
  ]);
  expect(messages[1].reasoning_content).toBe("think one\n\nthink two");
  expect(messages[1].content).toEqual([{ type: "text", text: "answer" }]);
});

test("tool-preceding reasoning is carried visibly AND attached as reasoning_content", async () => {
  const { buildMessages } = await import("../src/convert/request.mjs");
  const messages = buildMessages({
    model: { inputModalities: ["text"] },
    input: [
      { type: "reasoning", summary: [{ type: "summary_text", text: "plan call" }] },
      { type: "function_call", call_id: "c1", name: "spawn_agent", arguments: "{}" },
    ],
  });
  const assistant = messages[0];
  expect(assistant.role).toBe("assistant");
  expect(assistant.reasoning_content).toBe("plan call");
  expect(assistant.content).toEqual([{ type: "text", text: "<thought>\nplan call\n</thought>" }]);
  expect(assistant.tool_calls).toHaveLength(1);
  expect(assistant.tool_calls[0].function.name).toBe("spawn_agent");
});

test("trailing reasoning attaches to the last assistant message", async () => {
  const { buildMessages } = await import("../src/convert/request.mjs");
  const messages = buildMessages({
    model: { inputModalities: ["text"] },
    input: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
      { type: "reasoning", summary: [{ type: "summary_text", text: "trailing" }] },
    ],
  });
  const last = messages[messages.length - 1];
  expect(last.reasoning_content).toBe("trailing");
  expect(JSON.stringify(last.content)).toContain("<thought>");
});

test("custom tool calls and outputs round-trip into chat messages", async () => {
  const { buildMessages } = await import("../src/convert/request.mjs");
  const messages = buildMessages({
    model: { inputModalities: ["text"], imagePassthrough: false },
    input: [
      {
        type: "custom_tool_call",
        call_id: "call_1",
        name: "exec",
        input: "const r = await tools.mcp__exa__web_search_exa({query: 'x'})",
      },
      {
        type: "custom_tool_call_output",
        call_id: "call_1",
        output: [
          { type: "input_text", text: "Script completed\nOutput:\n" },
          { type: "input_text", text: '{"results": []}' },
        ],
      },
    ],
  });
  const assistant = messages.find((m) => m.role === "assistant" && m.tool_calls);
  expect(assistant.tool_calls).toHaveLength(1);
  expect(assistant.tool_calls[0].function.name).toBe("exec");
  expect(JSON.parse(assistant.tool_calls[0].function.arguments).content).toBe(
    "const r = await tools.mcp__exa__web_search_exa({query: 'x'})",
  );
  const tool = messages.find((m) => m.role === "tool");
  expect(tool.tool_call_id).toBe("call_1");
  expect(String(tool.content)).toContain("Script completed");
});

test("custom tool outputs with image parts get the omission marker", async () => {
  const { buildMessages } = await import("../src/convert/request.mjs");
  const messages = buildMessages({
    model: { inputModalities: ["text", "image"], imagePassthrough: false },
    input: [
      { type: "custom_tool_call", call_id: "call_2", name: "exec", input: "image(x)" },
      {
        type: "custom_tool_call_output",
        call_id: "call_2",
        output: [
          { type: "input_text", text: "rendered" },
          { type: "input_image", image_url: "data:image/png;base64,ZZZZ" },
        ],
      },
    ],
  });
  const text = JSON.stringify(messages);
  expect(text).not.toContain("ZZZZ");
  expect(text).toContain("image omitted");
});

test("opaque encrypted payloads are dropped, not leaked as text", async () => {
  const { buildMessages } = await import("../src/convert/request.mjs");
  const dense = "gAAAAAB" + "x".repeat(60);
  const messages = buildMessages({
    model: { inputModalities: ["text"] },
    input: [
      {
        type: "agent_message",
        content: [{ type: "encrypted_content", encrypted_content: dense }],
      },
    ],
  });
  expect(messages.length).toBe(0);
});

test("usage: real numbers win, zero input substituted, estimate fallback", async () => {
  const { finalizeUsage } = await import("../src/usage.mjs");
  const real = finalizeUsage(
    { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    { inputTokens: 999, outputTokens: 999 },
  );
  expect(real).toEqual({ input_tokens: 100, output_tokens: 20, total_tokens: 120 });

  const zeroInput = finalizeUsage(
    { prompt_tokens: 0, completion_tokens: 20, total_tokens: 20 },
    { inputTokens: 500, outputTokens: 999 },
  );
  expect(zeroInput.input_tokens).toBe(500);
  expect(zeroInput.total_tokens).toBe(520);

  const estimated = finalizeUsage(undefined, { inputTokens: 250, outputTokens: 25 });
  expect(estimated).toEqual({ input_tokens: 250, output_tokens: 25, total_tokens: 275 });

  const nothing = finalizeUsage(undefined, {});
  expect(nothing).toBeNull();
});

test("auth: bad secret is rejected", async () => {
  const res = await fetch(
    "http://127.0.0.1:" + server.port + "/_codextras/wrong/v1/models",
  );
  expect(res.status).toBe(404);
});
