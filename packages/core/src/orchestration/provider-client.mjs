// Provider client factory: keeps the composition root adapter-free and config injected.
//
// Orchestration depends on the provider adapter; server.mjs only depends on orchestration.

import { DeepSeekWebClient } from "@deepseek-web-opencode/deepseek-web/client";

export async function createProviderClient(credentials = {}, options = {}) {
  const client = new DeepSeekWebClient({
    ...credentials,
    headerOptions: options.headerOptions,
    capturePath: options.capturePath,
    devicePath: options.devicePath,
    log: options.log,
  });
  await client.init();
  return client;
}
