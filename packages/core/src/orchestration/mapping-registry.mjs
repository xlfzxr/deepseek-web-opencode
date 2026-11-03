// Tool and parameter aliases used to map tolerant model output to client schemas.

export const TOOL_ALIAS_GROUPS = Object.freeze({
  bash: ["bash", "run", "shell", "run_command", "execute", "terminal"],
  read: ["read", "read_file", "file_read"],
  edit: ["edit", "edit_file", "file_edit"],
  write: ["write", "write_file", "file_write"],
  glob: ["glob", "find_files", "file_glob"],
  grep: ["grep", "ripgrep", "rg", "search"],
  webfetch: ["webfetch", "web_fetch", "fetch_url"],
  todowrite: ["todowrite", "todo_write"],
  todoread: ["todoread", "todo_read"],
  task: ["task", "subtask"],
});

const PARAMETER_ALIAS_GROUPS = Object.freeze({
  bash: {
    cmd: "command",
    script: "command",
    cwd: "workdir",
    working_directory: "workdir",
    timeout_ms: "timeout",
  },
  read: {
    path: "filePath",
    file: "filePath",
    start_line: "offset",
    num_lines: "limit",
  },
  edit: {
    path: "filePath",
    file: "filePath",
    old: "oldString",
    old_text: "oldString",
    new: "newString",
    new_text: "newString",
  },
  write: {
    path: "filePath",
    file: "filePath",
    text: "content",
    body: "content",
  },
  glob: {
    glob: "pattern",
    root: "path",
  },
  grep: {
    query: "pattern",
    search: "pattern",
    regex: "pattern",
    root: "path",
    glob: "include",
  },
  webfetch: {
    href: "url",
    uri: "url",
  },
  todowrite: {
    items: "todos",
    todo_list: "todos",
  },
});

function compactName(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function lastNamePart(value) {
  return String(value || "").trim().split(/[.:/]/).filter(Boolean).at(-1) || "";
}

const TOOL_ALIAS_LOOKUP = new Map();
for (const [canonical, aliases] of Object.entries(TOOL_ALIAS_GROUPS)) {
  for (const alias of aliases) TOOL_ALIAS_LOOKUP.set(compactName(alias), canonical);
}

export function canonicalToolName(name) {
  const last = lastNamePart(name);
  return TOOL_ALIAS_LOOKUP.get(compactName(last)) || last;
}

function specNames(spec) {
  return [spec?.wireName, spec?.name].filter((name) => typeof name === "string" && name.trim());
}

function exactToolMatch(name, tools) {
  const normalized = String(name || "").trim().toLowerCase();
  return tools.find((tool) => specNames(tool).some((candidate) => candidate.trim().toLowerCase() === normalized));
}

function levenshteinDistance(left, right) {
  const a = compactName(left);
  const b = compactName(right);
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length];
}

function nameSimilarity(left, right) {
  const a = compactName(left);
  const b = compactName(right);
  const length = Math.max(a.length, b.length);
  return length ? 1 - levenshteinDistance(a, b) / length : 0;
}

function aliasesForSpec(spec) {
  const canonical = canonicalToolName(spec?.name || spec?.wireName);
  return TOOL_ALIAS_GROUPS[canonical] || [canonical];
}

export function resolveToolSpec(name, tools = []) {
  const candidates = Array.isArray(tools) ? tools : [];
  const exact = exactToolMatch(name, candidates);
  if (exact) return { spec: exact, method: "exact", score: 1 };

  const requestedCanonical = TOOL_ALIAS_LOOKUP.get(compactName(lastNamePart(name)));
  if (requestedCanonical) {
    const aliasMatch = candidates.find((tool) =>
      specNames(tool).some((candidate) => canonicalToolName(candidate) === requestedCanonical),
    );
    if (aliasMatch) return { spec: aliasMatch, method: "alias", score: 1 };
  }

  const scored = candidates
    .map((spec) => {
      const names = [...specNames(spec), ...aliasesForSpec(spec)];
      return {
        spec,
        score: Math.max(0, ...names.map((candidate) => nameSimilarity(name, candidate))),
      };
    })
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  const runnerUp = scored[1];
  if (!best || best.score < 0.74 || (runnerUp && best.score - runnerUp.score < 0.08)) {
    return { spec: null, method: "unresolved", score: best?.score || 0 };
  }
  return { spec: best.spec, method: "fuzzy", score: best.score };
}

function compactParameterName(value) {
  return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

export function resolveParameterName(toolName, name, properties = {}) {
  const keys = Object.keys(properties || {});
  if (keys.includes(name)) return name;

  const normalized = compactParameterName(name);
  const schemaMatch = keys.find((key) => compactParameterName(key) === normalized);
  if (schemaMatch) return schemaMatch;

  const aliases = PARAMETER_ALIAS_GROUPS[canonicalToolName(toolName)] || {};
  const target = aliases[String(name || "").trim().toLowerCase()];
  if (!target) return name;
  return keys.find((key) => compactParameterName(key) === compactParameterName(target)) || name;
}
