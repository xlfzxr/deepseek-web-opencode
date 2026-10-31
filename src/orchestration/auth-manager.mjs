// Auth manager: caches a single DeepSeek client, dedupes concurrent creation, supports invalidation.
import {
  AUTH_PATH,
  readCredentials,
  runDeepSeekLogin,
  summarizeCredentials,
} from "../deepseek-auth.mjs";
import { BridgeError, ErrorCode } from "./errors.mjs";

export function createAuthManager({
  loadCredentials = readCredentials,
  createClient,
  runLogin = runDeepSeekLogin,
  summarize = summarizeCredentials,
  authPath = AUTH_PATH,
} = {}) {
  let cached = null;
  let pending = null;

  function getClient(signal) {
    if (cached) return Promise.resolve(cached);
    if (pending) return pending;

    const load = (async () => {
      const credentials = await loadCredentials();
      if (!credentials?.cookie || !credentials?.bearer) {
        throw new BridgeError(ErrorCode.AUTH_MISSING, "还没有 DeepSeek 登录凭证，请先登录。");
      }
      return createClient(credentials, signal);
    })();

    pending = load.then(
      (client) => {
        cached = client;
        pending = null;
        return client;
      },
      (error) => {
        pending = null;
        throw error;
      },
    );
    return pending;
  }

  function invalidate() {
    cached = null;
    pending = null;
  }

  // Non-creating accessor for status/debug endpoints.
  function peek() {
    return cached;
  }

  // Auth lifecycle: the composition root never calls deepseek-auth directly.
  async function login(options = {}) {
    const credentials = await runLogin(options);
    invalidate();
    return credentials;
  }

  function getCredentials() {
    return loadCredentials();
  }

  async function describeCredentials() {
    return summarize(await loadCredentials());
  }

  return {
    getClient,
    invalidate,
    peek,
    login,
    getCredentials,
    describeCredentials,
    authPath,
  };
}
