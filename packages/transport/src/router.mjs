// HTTP router: endpoint table, CORS/preflight, method guard, favicon, static fallback.
import { applyCorsHeaders, createCorsPolicy, evaluateCors, writePreflightResponse } from "./cors.mjs";
import { notFound, sendJson, serveStaticFile } from "./http.mjs";

export function createRouter({ publicDir, handlers, corsPolicy = createCorsPolicy("") }) {
  return async function handleRequest(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    // CORS runs before every route so browser clients get a real error, not a
    // console-only "CORS request failed" message.
    const cors = evaluateCors(req, corsPolicy);
    if (cors.preflight && cors.allowed) {
      writePreflightResponse(res, cors, corsPolicy.maxAgeSeconds);
      return;
    }
    if (!cors.allowed) {
      sendJson(res, 403, { error: "origin_not_allowed", origin: cors.origin });
      return;
    }
    applyCorsHeaders(res, cors);

    if (req.method === "GET" && pathname === "/api/status") {
      return handlers.status(req, res, url);
    }

    if (req.method === "GET" && pathname === "/api/fingerprint") {
      return handlers.fingerprint(req, res, url);
    }

    if (req.method === "GET" && pathname === "/api/events") {
      return handlers.events(req, res, url);
    }

    if (req.method === "POST" && pathname === "/api/login") {
      return handlers.login(req, res, url);
    }

    if (req.method === "POST" && pathname === "/api/chat-test") {
      return handlers.chatTest(req, res, url);
    }

    if (req.method === "GET" && (pathname === "/v1/models" || pathname === "/models")) {
      return handlers.models(req, res, url);
    }

    if (
      req.method === "POST" &&
      (pathname === "/v1/chat/completions" || pathname === "/chat/completions")
    ) {
      return handlers.chatCompletions(req, res, url);
    }

    if (req.method === "POST" && (pathname === "/v1/responses" || pathname === "/responses")) {
      return handlers.responses(req, res, url);
    }

    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }

    if (pathname === "/favicon.ico") {
      res.writeHead(204, { "cache-control": "no-store" });
      res.end();
      return;
    }

    if (serveStaticFile(res, publicDir, pathname)) {
      return;
    }

    notFound(res);
  };
}
