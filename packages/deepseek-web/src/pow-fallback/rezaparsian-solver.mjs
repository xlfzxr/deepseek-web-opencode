// ESM adapter for the vendored @rezaparsian/deepseek-pow-solver (CommonJS).
//
// The bundled solver is a zero-dependency, self-contained DeepSeekHashV1 solver.
// It is used as a failover when the bridge's embedded WASM path throws, so a
// drifted or incompatible embedded payload does not take PoW down entirely.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDORED_SOLVER = path.join(HERE, "rezaparsian-pow-solver.cjs");
const VENDORED_WASM = path.join(HERE, "rezaparsian-sha3.wasm");

let solverPromise = null;

async function getSolver() {
  if (solverPromise) return solverPromise;
  solverPromise = (async () => {
    const PowSolver = require(VENDORED_SOLVER);
    const solver = new PowSolver(VENDORED_WASM);
    await solver.init();
    return solver;
  })();
  return solverPromise;
}

// Returns the solved nonce for a DeepSeekHashV1 challenge, matching the shape the
// bridge's own solver returns (a number), so callers can swap implementations.
export async function solveDeepSeekHashV1WithReza(challenge) {
  const solver = await getSolver();
  const payload = solver.solve(challenge);
  const answer = payload?.answer;
  if (typeof answer !== "number" || !Number.isFinite(answer)) {
    throw new Error("RezaParsian solver returned no numeric answer");
  }
  return answer;
}

export const REZA_WASM_PATH = VENDORED_WASM;
