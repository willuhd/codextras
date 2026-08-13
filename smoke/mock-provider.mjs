export function createMockProvider() {
  return Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/chat/completions") {
        return Response.json({ error: { message: "not found" } }, { status: 404 });
      }
      const body = await request.json();
      const effort = body.reasoning_effort || "none";
      const stream = body.stream !== false;

      const messages = Array.isArray(body.messages) ? body.messages : [];
      const hasImage = messages.some(
        (m) =>
          m.content &&
          Array.isArray(m.content) &&
          m.content.some((p) => p && p.type === "image_url"),
      );
      const carried = messages.some((m) => {
        if (m.role !== "assistant" || !Array.isArray(m.tool_calls) || !m.tool_calls.length) return false;
        const parts = Array.isArray(m.content)
          ? m.content
          : typeof m.content === "string"
            ? [{ type: "text", text: m.content }]
            : [];
        return parts.some((p) => p && typeof p.text === "string" && p.text.indexOf("CARRIED_TRACE") !== -1);
      });

      const reasoning = "mock reasoning for effort " + effort;
      const content =
        "mock answer (effort=" +
        effort +
        ";hasImage=" +
        hasImage +
        ";carried=" +
        carried +
        ")";
      const toolCalls = [
        { id: "call_1", type: "function", function: { name: "shell", arguments: "{\"cmd\":\"echo hi\"}" } },
        { id: "call_2", type: "function", function: { name: "collaboration__spawn_agent", arguments: "{}" } },
      ];
      const usage = {
        prompt_tokens: 25,
        completion_tokens: 30,
        total_tokens: 55,
        completion_tokens_details: { reasoning_tokens: 12 },
      };

      if (stream) {
        const encoder = new TextEncoder();
        const streamBody = new ReadableStream({
          start(controller) {
            const chunks = [
              { choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "mock reasoning" }, finish_reason: null }] },
              { choices: [{ index: 0, delta: { content: content }, finish_reason: null }] },
              { choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: "tool_calls" }] },
              { choices: [], usage },
            ];
            for (const chunk of chunks) {
              controller.enqueue(encoder.encode("data: " + JSON.stringify(chunk) + "\n\n"));
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
        return new Response(streamBody, {
          headers: { "Content-Type": "text/event-stream; charset=utf-8" },
        });
      }

      return Response.json({
        id: "chatcmpl-mock",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content,
              reasoning_content: reasoning,
              tool_calls: toolCalls,
            },
            finish_reason: "tool_calls",
          },
        ],
        usage,
      });
    },
  });
}
