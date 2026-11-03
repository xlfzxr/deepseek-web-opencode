import { runDeepSeekLogin } from "@deepseek-web-opencode/deepseek-web/auth";
import { readConfig } from "./config.mjs";

function parseArgs(argv) {
  const args = {
    attachOnly: false,
    port: undefined,
    timeoutMs: undefined,
    browser: "",
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--attach-only") {
      args.attachOnly = true;
    } else if (arg === "--port") {
      args.port = Number(argv[++i]);
    } else if (arg === "--timeout-ms") {
      args.timeoutMs = Number(argv[++i]);
    } else if (arg === "--browser") {
      args.browser = argv[++i] || "";
    }
  }
  return args;
}

const authConfig = readConfig().auth;
const cliOptions = Object.fromEntries(
  Object.entries(parseArgs(process.argv.slice(2))).filter(([, value]) => value !== undefined && value !== ""),
);

runDeepSeekLogin({
  authPath: authConfig.path,
  profileDir: authConfig.profileDir,
  port: authConfig.cdpPort,
  timeoutMs: authConfig.loginTimeoutMs,
  browser: authConfig.browser,
  ...cliOptions,
  onProgress: (message) => console.log(`[deepseek-login] ${message}`),
}).catch((error) => {
  console.error(`[deepseek-login] ${error?.message || String(error)}`);
  process.exitCode = 1;
});
