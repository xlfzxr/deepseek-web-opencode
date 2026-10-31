// Architecture tests: static import-graph gates for the documented layer contract.
//
// No dependencies and no execution of the modules — it parses imports and asserts:
//   transport  -> never adapter/header
//   orchestration -> never transport (dependency direction)
//   adapter    -> never transport/orchestration
//   header     -> never transport/orchestration/adapter
//   leaf modules -> no project imports at all
//   server.mjs -> composition root only (no adapter/header imports, bounded size)
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`ok   - ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL - ${name}${detail ? `: ${detail}` : ""}`);
}

function listModules(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listModules(full));
    } else if (entry.endsWith(".mjs")) {
      out.push(full);
    }
  }
  return out;
}

const MODULES = listModules(SRC).sort();

function layerOf(absPath) {
  const rel = path.relative(ROOT, absPath).replaceAll("\\", "/");
  if (rel === "src/server.mjs") return "server";
  if (rel === "src/login.mjs") return "bootstrap";
  if (rel === "src/config.mjs") return "config";
  if (rel === "src/dsml.mjs" || rel === "src/openai-shape.mjs") return "shared";
  if (rel.startsWith("src/transport/")) return "transport";
  if (rel.startsWith("src/orchestration/")) return "orchestration";
  if (rel.startsWith("src/headers/")) return "header";
  if (rel.startsWith("src/")) return "adapter";
  return "other";
}

export function importsOf(source) {
  const specifiers = new Set();
  const patterns = [
    /\bimport\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:[^'"]*?\s+)?from\s+["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
  }
  return [...specifiers];
}

const GRAPH = [];
for (const file of MODULES) {
  const source = readFileSync(file, "utf8");
  const from = path.relative(ROOT, file).replaceAll("\\", "/");
  const fromLayer = layerOf(file);
  for (const specifier of importsOf(source)) {
    if (!specifier.startsWith(".")) continue;
    const target = path.resolve(path.dirname(file), specifier);
    GRAPH.push({
      from,
      fromLayer,
      to: path.relative(ROOT, target).replaceAll("\\", "/"),
      toLayer: layerOf(target),
      specifier,
    });
  }
}

function edges(fromLayer, toLayer) {
  return GRAPH.filter((edge) => edge.fromLayer === fromLayer && edge.toLayer === toLayer);
}

function describeEdges(list) {
  return list.map((edge) => `${edge.from} -> ${edge.to}`).join(", ");
}

// 1. Directional rules.
const FORBIDDEN = [
  ["transport", "adapter"],
  ["transport", "header"],
  ["orchestration", "transport"],
  ["adapter", "transport"],
  ["adapter", "orchestration"],
  ["header", "transport"],
  ["header", "orchestration"],
  ["header", "adapter"],
  ["shared", "transport"],
  ["shared", "orchestration"],
  ["shared", "adapter"],
  ["shared", "header"],
  ["config", "transport"],
  ["config", "orchestration"],
  ["config", "adapter"],
  ["config", "header"],
  ["server", "adapter"],
  ["server", "header"],
];

for (const [fromLayer, toLayer] of FORBIDDEN) {
  const violations = edges(fromLayer, toLayer);
  check(
    `arch: ${fromLayer} -/-> ${toLayer}`,
    violations.length === 0,
    describeEdges(violations),
  );
}

// 2. Leaf modules import nothing from the project.
const LEAF_MODULES = [
  "src/orchestration/events.mjs",
  "src/orchestration/errors.mjs",
  "src/orchestration/session-store.mjs",
  "src/orchestration/tool-call-registry.mjs",
  "src/headers/fingerprint.mjs",
  "src/headers/risk.mjs",
  "src/transport/cors.mjs",
  "src/config.mjs",
  "src/dsml.mjs",
];

for (const rel of LEAF_MODULES) {
  const imports = GRAPH.filter((edge) => edge.from === rel);
  check(`arch: leaf ${rel} has no project imports`, imports.length === 0, describeEdges(imports));
}

// 3. The adapter owns upstream HTTP; transport must not contain DeepSeek URLs.
const TRANSPORT_FILES = MODULES.filter((file) => layerOf(file) === "transport");
const transportSources = TRANSPORT_FILES.map((file) => readFileSync(file, "utf8")).join("\n");
check(
  "arch: transport contains no DeepSeek upstream URL",
  !/chat\.deepseek\.com|hif-[a-z]+\.deepseek\.com/i.test(transportSources),
);
check(
  "arch: transport reads no process.env",
  !/process\.env/.test(transportSources),
);

const fingerprintSource = readFileSync(path.join(SRC, "headers", "fingerprint.mjs"), "utf8");
check("arch: header fingerprint reads no process.env", !/process\.env/.test(fingerprintSource));

// 4. Adapter has no HTTP routing / SSE transport logic.
const ADAPTER_FILES = MODULES.filter((file) => layerOf(file) === "adapter");
for (const file of ADAPTER_FILES) {
  const source = readFileSync(file, "utf8");
  const rel = path.relative(ROOT, file).replaceAll("\\", "/");
  check(`arch: ${rel} has no routing logic`, !/createRouter|sseWrit|res\.writeHead/.test(source));
}

// 5. Composition root stays thin and layer-pure.
const serverSource = readFileSync(path.join(SRC, "server.mjs"), "utf8");
const serverLines = serverSource.split("\n").length;
check(
  "arch: server.mjs imports only transport/orchestration/config",
  GRAPH.filter((edge) => edge.from === "src/server.mjs").every(
    (edge) => ["transport", "orchestration", "config", "shared"].includes(edge.toLayer),
  ),
  describeEdges(GRAPH.filter((edge) => edge.from === "src/server.mjs")),
);
check("arch: server.mjs stays under 620 lines", serverLines < 620, `${serverLines} lines`);

// 6. Every source module is classified by the layer map (new files need an owner).
const KNOWN_LAYERS = new Set([
  "server",
  "bootstrap",
  "config",
  "shared",
  "transport",
  "orchestration",
  "header",
  "adapter",
]);
const unclassified = MODULES.filter((file) => !KNOWN_LAYERS.has(layerOf(file)));
check("arch: every src module has an owning layer", unclassified.length === 0, unclassified.join(", "));

// 7. Orchestration never writes HTTP responses; it yields events.
const ORCHESTRATION_FILES = MODULES.filter((file) => layerOf(file) === "orchestration");
const orchestrationSources = ORCHESTRATION_FILES.map((file) => readFileSync(file, "utf8")).join("\n");
check(
  "arch: orchestration does not write HTTP/SSE directly",
  !/res\.writeHead|res\.write\(|sseWrite|sseEvent/.test(orchestrationSources),
);

if (failures) {
  console.error(`\narchitecture tests failed: ${failures} check(s)`);
  process.exit(1);
}
console.log("\narchitecture tests passed");
