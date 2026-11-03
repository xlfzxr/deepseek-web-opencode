// API entrypoint: bootstrap the HTTP server and compose routes with the runtime.
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { publicDir as webPublicDir } from "@deepseek-web-opencode/web/assets";
import {
  parseToolCallFromText,
  parseToolCallsFromText,
} from "@deepseek-web-opencode/core/orchestration/tool-parser";
import { readConfig } from "./config.mjs";
import { createCorsPolicy } from "@deepseek-web-opencode/transport/cors";
import { createRouter } from "@deepseek-web-opencode/transport/router";
import { createRuntime } from "./runtime.mjs";

export { createRuntime, parseToolCallFromText, parseToolCallsFromText };

const PUBLIC_DIR = webPublicDir;

export async function startServer(port, options = {}) {
  const config = options.config || readConfig();
  const runtime = createRuntime(config);
  const listenPort = port === undefined ? config.port : Number(port);

  try {
    const credentials = await runtime.authManager.getCredentials();
    if (credentials) {
      runtime.pushLog("已找到本地保存的凭证。");
    } else {
      runtime.pushLog("还没有保存的凭证。");
    }
  } catch {
    runtime.pushLog("还没有保存的凭证。");
  }

  const corsPolicy = createCorsPolicy(config.cors.allowOrigins, {
    maxAgeSeconds: config.cors.maxAgeSeconds,
  });
  const handleRequest = createRouter({
    publicDir: PUBLIC_DIR,
    corsPolicy,
    handlers: runtime.handlers,
  });

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => runtime.handleError(error, res));
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(listenPort, config.host);
  });

  runtime.setPort(server.address().port);

  const shownHost = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
  console.log(`DeepSeek 桥接器：http://${shownHost}:${server.address().port}`);
  return server;
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
