import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const smokeDir = mkdtempSync(path.join(tmpdir(), "ds-bridge-smoke-"));
process.env.DEEPSEEK_AUTH_PATH = path.join(smokeDir, "credentials.json");
process.env.DEEPSEEK_AUTH_DIR = smokeDir;
process.env.DEEPSEEK_RISK_HEADERS = "0";

const { startServer } = await import("../src/server.mjs");
const { createSessionStore } = await import("../src/orchestration/session-store.mjs");

const failures = [];
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`ok   - ${name}`);
  } else {
    console.error(`FAIL - ${name}${detail ? `: ${detail}` : ""}`);
    failures.push(name);
  }
}

async function sessionStoreChecks() {
  const store = createSessionStore({ ttlMs: 15 });
  store.set("k", { v: 1 });
  check("session-store: get fresh entry", store.get("k")?.v === 1);
  await new Promise((resolve) => setTimeout(resolve, 25));
  check("session-store: expired entry dropped", store.get("k") === undefined);
  store.set("k2", 2);
  store.set("k3", 3);
  store.delete("k2");
  check("session-store: delete works", store.get("k2") === undefined && store.get("k3") === 3);
}

async function main() {
  sessionStoreChecks();

  const server = await startServer(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const modelsRes = await fetch(`${base}/v1/models`);
  const modelsJson = await modelsRes.json();
  check("GET /v1/models -> 200", modelsRes.status === 200);
  check("GET /v1/models -> data array", Array.isArray(modelsJson.data) && modelsJson.data.length > 0);

  const chatJsonRes = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-web/deepseek-chat",
      stream: false,
      messages: [{ role: "user", content: "ping" }],
    }),
  });
  const chatJsonBody = await chatJsonRes.json();
  check(
    "POST /v1/chat/completions (stream=false, no auth) -> 500 + valid JSON error",
    chatJsonRes.status === 500 && typeof chatJsonBody.error === "string" && chatJsonBody.error.length > 0,
  );

  const chatSseRes = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-web/deepseek-chat",
      stream: true,
      messages: [{ role: "user", content: "ping" }],
    }),
  });
  const chatSseText = await chatSseRes.text();
  check(
    "POST /v1/chat/completions (stream=true, no auth) -> SSE frames + [DONE]",
    chatSseRes.status === 200 &&
      chatSseRes.headers.get("content-type").includes("text/event-stream") &&
      chatSseText.includes("data: ") &&
      chatSseText.includes("data: [DONE]"),
  );

  const responsesJsonRes = await fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-web/deepseek-chat",
      stream: false,
      input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }],
    }),
  });
  const responsesJsonBody = await responsesJsonRes.json();
  check(
    "POST /v1/responses (stream=false, no auth) -> 500 + valid JSON error",
    responsesJsonRes.status === 500 && typeof responsesJsonBody.error === "string" && responsesJsonBody.error.length > 0,
  );

  const responsesSseRes = await fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-web/deepseek-chat",
      stream: true,
      input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }],
    }),
  });
  const responsesSseText = await responsesSseRes.text();
  check(
    "POST /v1/responses (stream=true, no auth) -> response.created before error",
    responsesSseText.includes("event: response.created") && responsesSseText.includes("data: [DONE]"),
  );

  const statusRes = await fetch(`${base}/api/status`);
  const statusJson = await statusRes.json();
  check("GET /api/status -> 200", statusRes.status === 200 && "running" in statusJson);

  const indexRes = await fetch(`${base}/`);
  const indexHtml = await indexRes.text();
  check(
    "GET / -> static index.html",
    indexRes.status === 200 &&
      indexRes.headers.get("content-type").includes("text/html") &&
      indexHtml.includes("<html"),
  );

  const missingRes = await fetch(`${base}/does-not-exist.txt`);
  check("GET missing static path -> 404 JSON", missingRes.status === 404);

  server.close();
}

main()
  .then(() => {
    if (failures.length) {
      console.error(`\nsmoke failed: ${failures.length} check(s)`);
      process.exit(1);
    }
    console.log("\nsmoke passed");
  })
  .catch((error) => {
    console.error(`smoke crashed: ${error?.stack || error}`);
    process.exit(1);
  });
