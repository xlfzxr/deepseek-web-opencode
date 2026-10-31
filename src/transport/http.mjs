// HTTP helpers: JSON responses, request body reading, and static file serving.
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";

export function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

export function notFound(res) {
  sendJson(res, 404, { error: "not_found" });
}

export function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".png") return "image/png";
  return "application/octet-stream";
}

export function safePublicPath(publicDir, urlPath) {
  const pathname = urlPath === "/" ? "/index.html" : urlPath;
  const decoded = decodeURIComponent(pathname);
  const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const fullPath = path.join(publicDir, normalized);
  if (!fullPath.startsWith(publicDir)) {
    return null;
  }
  return fullPath;
}

export async function readJsonBody(req, maxBytes = 2_000_000) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error("请求体太大");
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

export function serveStaticFile(res, publicDir, urlPath) {
  const filePath = safePublicPath(publicDir, urlPath);
  if (!filePath || !existsSync(filePath)) {
    return false;
  }
  res.writeHead(200, {
    "content-type": contentTypeFor(filePath),
    "cache-control": "no-store",
  });
  createReadStream(filePath).pipe(res);
  return true;
}
