// Import a raw browser/CDP header capture into a replayable fingerprint file.
//
// Usage:
//   node scripts/fingerprint-from-capture.mjs <capture.json> [--out path]
//
// The input can be any of:
//   - the raw capture written by `.capture-ds2.mjs` ({ hits: [{ url, headers, extra }] })
//   - a hand-made { headers: { ... } } file
//   - a flat header map
// Credentials (cookie/authorization/PoW), hop-by-hop headers and expiring x-hif-* tokens
// are dropped before writing, so the result is safe to keep on disk.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildFingerprint } from "../src/headers/fingerprint.mjs";
import { loadCaptureFile } from "../src/headers/upstream.mjs";

const args = process.argv.slice(2);
const input = args.find((arg) => !arg.startsWith("--"));
const outIndex = args.indexOf("--out");
const outPath =
  outIndex >= 0 && args[outIndex + 1]
    ? args[outIndex + 1]
    : process.env.DEEPSEEK_FINGERPRINT_PATH ||
      path.join(process.cwd(), ".deepseek-auth", "fingerprint.json");

if (!input) {
  console.error("用法：node scripts/fingerprint-from-capture.mjs <capture.json> [--out path]");
  process.exit(1);
}

const capture = loadCaptureFile(path.resolve(input));
if (!capture) {
  console.error(`没有从 ${input} 找到可用的请求头（需要 /api/v0/chat/completion 的抓包）。`);
  process.exit(1);
}

const preview = buildFingerprint({
  capturedHeaders: capture.headers,
  deviceId: "00000000-0000-4000-8000-000000000000",
  capturedAt: new Date().toISOString(),
  capturedSource: input,
});

const payload = {
  capturedAt: new Date().toISOString(),
  source: input,
  note: "Sanitized browser fingerprint imported by scripts/fingerprint-from-capture.mjs",
  headers: capture.headers,
};

mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);

console.log(`已写入：${outPath}`);
console.log(`保留请求头 ${Object.keys(capture.headers).length} 个，丢弃 ${capture.dropped.length} 个。`);
if (capture.dropped.length) {
  console.log(`丢弃：${capture.dropped.join(", ")}`);
}
for (const key of [
  "user-agent",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "origin",
  "referer",
  "x-client-version",
  "x-client-locale",
  "x-client-timezone-offset",
  "x-device-id",
]) {
  if (capture.headers[key]) console.log(`  ${key}: ${capture.headers[key]}`);
}
if (preview.warnings.length) {
  console.log("\n一致性检查：");
  for (const warning of preview.warnings) console.log(`  ! ${warning}`);
} else {
  console.log("\n一致性检查通过。");
}
