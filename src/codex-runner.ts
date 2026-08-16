/**
 * Codex-bound compatibility surface.
 *
 * The real implementation now lives in `cli-runner.ts` and is shared with
 * every provider. This module keeps the original Codex-specific exports so
 * existing callers and tests continue to work unchanged. New code should
 * prefer `runCli(getProvider(id), ...)` from `cli-runner.js`.
 */
import {
  probeAuthFor,
  probeVersionFor,
  runCli,
  type RunCliOptions,
  type RunCliResult,
  type RunCliSuccess,
} from './cli-runner.js';
import { codexProvider } from './providers/codex.js';
import type { BuildArgsInput } from './providers/types.js';

export { _resetSpawnForTests, _setSpawnForTests } from './cli-runner.js';
export type { SandboxMode } from './providers/types.js';
export type { CodexEvent } from './providers/codex.js';

export type RunCodexOptions = RunCliOptions;
export type RunCodexSuccess = RunCliSuccess;
export type RunCodexResult = RunCliResult;

/**
 * Builds the full Codex argv including the trailing `-` that tells Codex the
 * prompt arrives on stdin. The provider itself stops short of that marker
 * because prompt delivery is the transport's concern, not the flag builder's.
 */
export function buildCodexArgs(opts: BuildArgsInput): string[] {
  return [...codexProvider.buildArgs(opts), '-'];
}

export async function runCodex(opts: RunCodexOptions): Promise<RunCodexResult> {
  return runCli(codexProvider, opts);
}

export async function probeAuth(): Promise<{ loggedIn: boolean; raw: string }> {
  const res = await probeAuthFor(codexProvider);
  return { loggedIn: res.loggedIn, raw: res.raw };
}

export async function probeVersion(): Promise<string | null> {
  return probeVersionFor(codexProvider);
}
