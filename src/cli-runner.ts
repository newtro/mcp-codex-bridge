import crossSpawn from 'cross-spawn';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  looksLikeAuthFailure,
  looksLikeRateLimit,
  makeFailure,
  type CliFailure,
} from './errors.js';
import { logInvocation, nowIso } from './logger.js';
import type { AuthProbeResult, CliProvider, ErrorKind, SandboxMode } from './providers/types.js';

// The spawn function is held in a module-level variable so tests can inject
// a fake without forcing the production code to use vi.mock hoisting tricks.
// Production code never reassigns this; only the _setSpawnForTests export
// (named with an underscore to discourage non-test consumers) does.
type SpawnFn = (
  command: string,
  args: readonly string[],
  opts?: unknown,
) => ChildProcessWithoutNullStreams;
let spawn: SpawnFn = crossSpawn as unknown as SpawnFn;

function assertTestContext(name: string): void {
  // The injection setters are public exports because the test harness loads
  // this module normally. Throwing when NODE_ENV is not 'test' (vitest sets
  // it automatically) keeps the foot-gun closed for any production consumer
  // that imports the underscore-prefixed exports out of curiosity.
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `${name} is a test-only export. NODE_ENV must be 'test' to call it. ` +
        'If you are running production code, do not import the underscore-prefixed exports from cli-runner.',
    );
  }
}

export function _setSpawnForTests(fn: SpawnFn): void {
  assertTestContext('_setSpawnForTests');
  spawn = fn;
}

export function _resetSpawnForTests(): void {
  assertTestContext('_resetSpawnForTests');
  spawn = crossSpawn as unknown as SpawnFn;
}

export type { SandboxMode };

export interface RunCliOptions {
  /** Prompt text. How it reaches the CLI is the provider's decision. */
  prompt: string;
  /** Working directory. Codex requires a git repo unless skipGitCheck is set. */
  cwd?: string;
  /** Sandbox policy, mapped to the provider's own vocabulary. */
  sandbox?: SandboxMode;
  /** Additional writable directories beyond cwd. Codex only. */
  addDirs?: string[];
  /** Override the model for this call. */
  model?: string;
  /** Reasoning effort. Ignored by providers without a per-call flag. */
  reasoningEffort?: string;
  /** JSON Schema constraining the final answer. Ignored where unsupported. */
  jsonSchema?: string;
  /** Cap on agent turns. Ignored where unsupported. */
  maxTurns?: number;
  /** Per-call timeout. Falls back to the provider's env var, then 5 minutes. */
  timeoutMs?: number;
  /** Allow running outside a git repo. Codex only. */
  skipGitCheck?: boolean;
  /** For logging only: identifies the MCP tool that initiated this call. */
  tool: string;
}

export interface RunCliSuccess {
  ok: true;
  finalMessage: string;
  threadId: string | null;
  /** Natively parsed structured output, when the provider supports schemas. */
  structured: unknown;
  events: unknown[];
  exitCode: number;
  stderr: string;
  durationMs: number;
}

export type RunCliResult = RunCliSuccess | (CliFailure & { durationMs: number });

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const KILL_GRACE_MS = 2000;

function resolveBinary(provider: CliProvider): string {
  return process.env[provider.binaryEnvVar] ?? provider.defaultBinary;
}

function resolveTimeout(provider: CliProvider, opts: RunCliOptions): number {
  if (opts.timeoutMs !== undefined) return opts.timeoutMs;
  const envVal = process.env[provider.timeoutEnvVar];
  if (envVal) {
    const parsed = Number.parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_TIMEOUT_MS;
}

interface SpawnOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  timedOut: boolean;
  spawnError: NodeJS.ErrnoException | null;
}

function spawnCli(
  binary: string,
  args: string[],
  stdinText: string | null,
  timeoutMs: number,
  onStdout: (chunk: string) => void,
): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    let stderrBuf = '';
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    let child: ChildProcessWithoutNullStreams;

    try {
      // cross-spawn resolves Windows .cmd/.ps1 wrappers without shell:true.
      // shell:true would open argument-injection vectors via user-controlled
      // strings, so we avoid it entirely.
      child = spawn(binary, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;
    } catch (err) {
      resolve({
        exitCode: null,
        signal: null,
        stderr: '',
        timedOut: false,
        spawnError: err as NodeJS.ErrnoException,
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // SIGTERM may be ignored by a misbehaving child. Hard-kill after grace.
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }, KILL_GRACE_MS);
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        exitCode: null,
        signal: null,
        stderr: stderrBuf,
        timedOut,
        spawnError: err as NodeJS.ErrnoException,
      });
    });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => onStdout(chunk));
    child.stderr.on('data', (chunk: string) => {
      stderrBuf += chunk;
    });

    // The CLI can exit before consuming the full prompt (auth failure, crash).
    // Without this listener the resulting EPIPE becomes an unhandled stream
    // error and takes down the MCP host process.
    child.stdin.on('error', () => {
      // Intentional swallow. The real failure is reported via the close event
      // with the captured stderr.
    });

    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ exitCode, signal, stderr: stderrBuf, timedOut, spawnError: null });
    });

    if (stdinText !== null) {
      // Stdin must be closed so the CLI knows the prompt is complete.
      child.stdin.write(stdinText);
    }
    child.stdin.end();
  });
}

function summariseArgs(provider: CliProvider, opts: RunCliOptions): Record<string, unknown> {
  return {
    provider: provider.id,
    cwd: opts.cwd ?? null,
    sandbox: opts.sandbox ?? null,
    model: opts.model ?? null,
    reasoningEffort: opts.reasoningEffort ?? null,
    jsonSchema: opts.jsonSchema ? `${opts.jsonSchema.length} chars` : null,
    promptChars: opts.prompt.length,
    timeoutMs: resolveTimeout(provider, opts),
    skipGitCheck: opts.skipGitCheck ?? false,
    addDirs: opts.addDirs?.length ?? 0,
  };
}

export async function runCli(
  provider: CliProvider,
  opts: RunCliOptions,
): Promise<RunCliResult> {
  const startedAt = Date.now();
  const binary = resolveBinary(provider);
  const parser = provider.createParser();
  const argSummary = summariseArgs(provider, opts);
  const timeoutMs = resolveTimeout(provider, opts);

  const fail = (
    kind: ErrorKind,
    message: string,
    stderr: string,
    exitCode: number | null,
    durationMs: number,
  ): RunCliResult => {
    logInvocation({
      ts: nowIso(),
      provider: provider.id,
      tool: opts.tool,
      durationMs,
      exitCode,
      errorClass: `${provider.errorPrefix}_${kind}` as never,
      argSummary,
    });
    return { ...makeFailure(provider, kind, message, stderr, exitCode), durationMs };
  };

  const transport = await provider.preparePrompt(opts.prompt);
  let outcome: SpawnOutcome;
  try {
    const args = [
      ...provider.buildArgs({
        sandbox: opts.sandbox,
        cwd: opts.cwd,
        model: opts.model,
        reasoningEffort: provider.supportsReasoningEffort ? opts.reasoningEffort : undefined,
        skipGitCheck: opts.skipGitCheck,
        addDirs: opts.addDirs,
        jsonSchema: provider.supportsJsonSchema ? opts.jsonSchema : undefined,
        maxTurns: opts.maxTurns,
      }),
      ...transport.args,
    ];
    outcome = await spawnCli(binary, args, transport.stdin, timeoutMs, (c) => parser.push(c));
  } finally {
    // Runs on every path, so a temp prompt file never outlives its call.
    await transport.cleanup();
  }

  const durationMs = Date.now() - startedAt;
  const { events, finalMessage, threadId, structured, parseFailures } = parser.end();

  // Spawn-time failures: missing binary, permission denied. These never
  // produced any CLI output, so the error class comes from errno.
  if (outcome.spawnError) {
    const code = outcome.spawnError.code;
    // EACCES means the binary exists but cannot be executed (permission bit on
    // POSIX, file locked on Windows). Same remediation as ENOENT from the
    // caller's perspective: the CLI is unusable.
    if (code === 'ENOENT' || code === 'EACCES') {
      return fail(
        'NOT_FOUND',
        `${provider.displayName} CLI binary not usable (looked for '${binary}'). errno=${code}`,
        outcome.stderr,
        null,
        durationMs,
      );
    }
    return fail(
      'FAILED',
      `Failed to spawn ${provider.displayName} CLI: ${outcome.spawnError.message}`,
      outcome.stderr,
      null,
      durationMs,
    );
  }

  if (outcome.timedOut) {
    return fail(
      'TIMEOUT',
      `${provider.displayName} CLI exceeded timeout of ${timeoutMs}ms and was killed.`,
      outcome.stderr,
      outcome.exitCode,
      durationMs,
    );
  }

  // Non-zero exit. Classify against known patterns before falling back.
  if (outcome.exitCode !== 0) {
    // Detectors search events too, so a rate-limit or auth message surfaced in
    // a non-message event is still classified correctly. Built lazily because
    // the success path never consults it.
    const eventsSerialised = events.map((e) => JSON.stringify(e)).join('\n');
    const combinedHaystack = `${finalMessage}\n${eventsSerialised}`;
    let kind: ErrorKind = 'FAILED';
    if (looksLikeAuthFailure(provider, outcome.stderr, combinedHaystack)) {
      kind = 'NOT_AUTHENTICATED';
    } else if (looksLikeRateLimit(outcome.stderr, combinedHaystack)) {
      kind = 'RATE_LIMITED';
    }
    return fail(
      kind,
      `${provider.displayName} CLI exited with code ${outcome.exitCode}${
        outcome.signal ? ` (signal ${outcome.signal})` : ''
      }.`,
      outcome.stderr,
      outcome.exitCode,
      durationMs,
    );
  }

  // Exit 0 with no final message means the CLI completed without producing
  // user-visible output: a tool-only turn, an interrupted run, or an upstream
  // output-schema change. Returning ok:true with an empty message would hide
  // that failure from the calling agent.
  if (finalMessage === '') {
    const detail =
      events.length === 0
        ? `no parseable output; ${parseFailures.length} unparseable chunks`
        : `${events.length} events received; no final assistant message among them; ${parseFailures.length} unparseable chunks`;
    return fail(
      'PARSE_ERROR',
      `${provider.displayName} exited cleanly; no final assistant message was produced (${detail}).`,
      outcome.stderr,
      0,
      durationMs,
    );
  }

  logInvocation({
    ts: nowIso(),
    provider: provider.id,
    tool: opts.tool,
    durationMs,
    exitCode: 0,
    errorClass: 'OK',
    argSummary,
  });

  return {
    ok: true,
    finalMessage,
    threadId,
    structured,
    events,
    exitCode: 0,
    stderr: outcome.stderr,
    durationMs,
  };
}

const PROBE_TIMEOUT_MS = 10000;

/**
 * Runs a short-lived probe subprocess and returns its combined output. Hard
 * capped at PROBE_TIMEOUT_MS so a network-bound credential refresh cannot
 * stall the MCP server indefinitely.
 */
function runProbe(
  binary: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string; exitCode: number | null; spawned: boolean }> {
  return new Promise((resolve) => {
    let stdoutBuf = '';
    let stderrBuf = '';
    let settled = false;
    const settle = (v: {
      stdout: string;
      stderr: string;
      exitCode: number | null;
      spawned: boolean;
    }): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(binary, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;
    } catch {
      settle({ stdout: '', stderr: '', exitCode: null, spawned: false });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already dead. The close handler still fires.
      }
      settle({ stdout: stdoutBuf, stderr: 'probe timed out', exitCode: null, spawned: true });
    }, PROBE_TIMEOUT_MS);
    child.on('error', () => {
      clearTimeout(timer);
      settle({ stdout: '', stderr: '', exitCode: null, spawned: false });
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (stdoutBuf += c));
    child.stderr.on('data', (c: string) => (stderrBuf += c));
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      settle({ stdout: stdoutBuf, stderr: stderrBuf, exitCode, spawned: true });
    });
  });
}

/**
 * Lightweight auth probe that does not spawn a full agent turn. Useful for
 * the status tools and for fail-fast paths before expensive calls.
 */
export async function probeAuthFor(provider: CliProvider): Promise<AuthProbeResult> {
  const binary = resolveBinary(provider);
  const res = await runProbe(binary, provider.authProbeArgs);
  if (!res.spawned) {
    return { loggedIn: false, raw: 'spawn failed', defaultModel: null };
  }
  return provider.interpretAuthProbe(res.stdout, res.stderr, res.exitCode);
}

export async function probeVersionFor(provider: CliProvider): Promise<string | null> {
  const binary = resolveBinary(provider);
  const res = await runProbe(binary, provider.versionArgs);
  if (!res.spawned) return null;
  if (res.exitCode === 0 && res.stdout.trim()) return res.stdout.trim();
  return null;
}
