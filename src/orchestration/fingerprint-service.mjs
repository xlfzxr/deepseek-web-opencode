// Fingerprint inspection service for observability (status + /api/fingerprint).
//
// The server must not import the header layer directly; this service uses the adapter's
// inspection helper and caches the derived layer so status polling stays cheap.

import { describeFingerprintHeaders } from "../deepseek-web-client.mjs";

export function createFingerprintService({ loadCredentials = async () => null, headerOptions = {} } = {}) {
  let cached = null;
  let cachedKey = "";

  function describeFor(credentials = {}) {
    const key = [
      credentials.cookie || "",
      credentials.bearer || "",
      credentials.userAgent || "",
    ].join("\u0000");
    if (cached && key === cachedKey) return cached;
    cached = describeFingerprintHeaders({
      cookie: credentials.cookie,
      bearer: credentials.bearer,
      userAgent: credentials.userAgent,
      headerOptions,
    });
    cachedKey = key;
    return cached;
  }

  async function describe(client) {
    if (client?.describeFingerprint) return client.describeFingerprint();
    return describeFor((await loadCredentials()) || {});
  }

  function invalidate() {
    cached = null;
    cachedKey = "";
  }

  return { describe, describeFor, invalidate };
}
