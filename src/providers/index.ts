import { codexProvider } from './codex.js';
import { grokProvider } from './grok.js';
import type { CliProvider, ProviderId } from './types.js';

const REGISTRY: Record<ProviderId, CliProvider> = {
  codex: codexProvider,
  grok: grokProvider,
};

export const PROVIDER_IDS = Object.keys(REGISTRY) as ProviderId[];

export function getProvider(id: ProviderId): CliProvider {
  const provider = REGISTRY[id];
  if (!provider) {
    throw new Error(`Unknown provider '${id}'. Known providers: ${PROVIDER_IDS.join(', ')}.`);
  }
  return provider;
}

export { codexProvider, grokProvider };
export type { CliProvider, ProviderId };
export * from './types.js';
