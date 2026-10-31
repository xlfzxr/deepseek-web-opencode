import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const authDir = mkdtempSync(path.join(tmpdir(), "ds-bridge-e2e-"));
const authPath = path.join(authDir, "credentials.json");
writeFileSync(authPath, JSON.stringify({ cookie: "cookie=test", bearer: "bearer-test" }));
process.env.DEEPSEEK_AUTH_PATH = authPath;

const DSML =
  '<|DSML|invoke name="get_weather">' +
  '<|DSML|parameter name="city" string="true">Jakarta</|DSML|parameter>' +
  "</|DSML|invoke>";

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const textStream = () => {
  const payloads = [{ response_message_id: "msg-1" }, { p: "response/content", v: DSML }];
  const text = payloads.map((p) => "data: " + JSON.stringify(p)).join("\n\n");
  return new Response(text + "\n\ndata: [DONE]\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
};

const realFetch = globalThis.fetch;

globalThis.fetch = async (url, options) => {
  const u = String(url);
  if (u.startsWith("http://127.0.0.1:")) return realFetch(url, options);
  if (u.includes("/api/v0/client/settings")) return jsonResponse({ code: 0, data: {} });
  if (u.includes("/api/v0/chat/create_pow_challenge")) {
    const challenge = {
      algorithm: "sha256",
      challenge: "pow-target",
      salt: "salt",
      difficulty: 2,
      expire_at: Math.floor(Date.now() / 1000) + 300,
    };
    return jsonResponse({ data: { biz_data: { challenge } } });
  }
  if (u.includes("/api/v0/chat_session/create")) {
    return jsonResponse({ data: { biz_data: { chat_session: { id: "sess-e2e" } } } });
  }
  if (u.includes("/api/v0/chat/completion")) return textStream();
  throw new Error("unexpected fetch: " + u);
};

const { startServer } = await import("../src/server.mjs");

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log("ok   - " + name);
    return;
  }
  failures += 1;
  console.error("FAIL - " + name + (detail ? ": " + detail : ""));
}

function sseData(text) {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6).trim())
    .filter((data) => data && data !== "[DONE]")
    .map((data) => {
      try {
        return JSON.parse(data);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const weatherTool = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get weather",
    parameters: { type: "object", properties: { city: { type: "string" } } },
  },
};

async function postJson(base, route, body) {
  const res = await fetch(base + route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { res, text };
}

async function main() {
  const server = await startServer(0);
  const base = "http://127.0.0.1:" + server.address().port;

  const chatBody = (stream) => ({
    model: "deepseek-web/deepseek-chat",
    stream,
    tools: [weatherTool],
    messages: [{ role: "user", content: "weather in Jakarta?" }],
  });

  const chatStream = await postJson(base, "/v1/chat/completions", chatBody(true));
  const chatFrames = sseData(chatStream.text);
  const toolDelta = chatFrames
    .flatMap((frame) => frame.choices || [])
    .map((choice) => choice.delta?.tool_calls)
    .find(Boolean);
  const finish = chatFrames
    .flatMap((frame) => frame.choices || [])
    .map((choice) => choice.finish_reason)
    .find(Boolean);
  check("chat stream: tool_calls delta", Boolean(toolDelta));
  check("chat stream: tool name", toolDelta?.[0]?.function?.name === "get_weather");
  check(
    "chat stream: tool arguments",
    (() => {
      try {
        return JSON.parse(toolDelta?.[0]?.function?.arguments || "{}").city === "Jakarta";
      } catch {
        return false;
      }
    })(),
  );
  check("chat stream: finish_reason tool_calls", finish === "tool_calls");
  check("chat stream: DONE sent", chatStream.text.includes("data: [DONE]"));

  const chatJson = await postJson(base, "/v1/chat/completions", chatBody(false));
  const chatJsonParsed = JSON.parse(chatJson.text);
  const calls = chatJsonParsed.choices?.[0]?.message?.tool_calls || [];
  check("chat json: tool_calls length", calls.length === 1);
  check("chat json: tool name", calls[0]?.function?.name === "get_weather");
  check("chat json: finish_reason tool_calls", chatJsonParsed.choices?.[0]?.finish_reason === "tool_calls");

  const responsesBody = (stream) => ({
    model: "deepseek-web/deepseek-chat",
    stream,
    tools: [weatherTool],
    input: "weather in Jakarta?",
  });

  const respJson = await postJson(base, "/v1/responses", responsesBody(false));
  const respParsed = JSON.parse(respJson.text);
  const callItem = (respParsed.output || []).find((item) => item.type === "function_call");
  check("responses json: function_call item", Boolean(callItem));
  check("responses json: tool name", callItem?.name === "get_weather");
  check(
    "responses json: arguments",
    (() => {
      try {
        return JSON.parse(callItem?.arguments || "{}").city === "Jakarta";
      } catch {
        return false;
      }
    })(),
  );

  const respStream = await postJson(base, "/v1/responses", responsesBody(true));
  check("responses stream: function_call event", respStream.text.includes('"function_call"'));
  check("responses stream: completed event", respStream.text.includes("response.completed"));
  check("responses stream: DONE sent", respStream.text.includes("data: [DONE]"));

  server.close();
}

main()
  .then(() => {
    if (failures) {
      console.error("\ntool-call tests failed: " + failures);
      process.exit(1);
    }
    console.log("\ntool-call tests passed");
  })
  .catch((error) => {
    console.error("tool-call tests crashed: " + (error?.stack || error));
    process.exit(1);
  });
