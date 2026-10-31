import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultAuth = path.join(path.resolve(__dirname, ".."), ".deepseek-auth", "credentials.json");
const authPath = process.env.DEEPSEEK_AUTH_PATH || defaultAuth;

if (!existsSync(authPath)) {
  console.log("SKIP: no DeepSeek credentials at " + authPath);
  console.log("Run `npm run login` first (needs adb forward on Android).");
  process.exit(2);
}

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

function joinStreamContent(text) {
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
    .filter(Boolean)
    .map((frame) => frame.choices?.[0]?.delta?.content || "")
    .join("");
}

const PROMPT = "Reply with exactly this token and nothing else: LIVE_OK";

async function main() {
  const server = await startServer(0);
  const base = "http://127.0.0.1:" + server.address().port;

  const t0 = Date.now();
  const res = await fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-web/deepseek-chat",
      stream: false,
      messages: [{ role: "user", content: PROMPT }],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const body = await res.json();
  const content = body?.choices?.[0]?.message?.content || "";
  check("live chat: HTTP 200", res.status === 200, JSON.stringify(body).slice(0, 200));
  check("live chat: reply contains LIVE_OK", content.includes("LIVE_OK"), JSON.stringify(content).slice(0, 200));
  console.log("     reply: " + JSON.stringify(content.slice(0, 80)));
  console.log("     elapsed: " + (Date.now() - t0) + "ms");

  const t1 = Date.now();
  const sres = await fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-web/deepseek-chat",
      stream: true,
      messages: [{ role: "user", content: PROMPT }],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const streamText = await sres.text();
  const streamContent = joinStreamContent(streamText);
  check("live stream: HTTP 200", sres.status === 200);
  check("live stream: [DONE] sent", streamText.includes("data: [DONE]"));
  check("live stream: reply contains LIVE_OK", streamContent.includes("LIVE_OK"), JSON.stringify(streamContent).slice(0, 200));
  console.log("     stream reply: " + JSON.stringify(streamContent.slice(0, 80)));
  console.log("     elapsed: " + (Date.now() - t1) + "ms");

  server.close();
}

main()
  .then(() => {
    if (failures) {
      console.error("\nlive check failed: " + failures + " check(s)");
      process.exit(1);
    }
    console.log("\nlive check passed");
  })
  .catch((error) => {
    const message = error?.name === "TimeoutError" ? "request timed out" : error?.message || String(error);
    console.error("live check crashed: " + message);
    console.error("Hint: credentials may be expired; run `npm run login` again.");
    process.exit(1);
  });
