import spawn from 'cross-spawn';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  looksLikeAuthFailure,
  looksLikeRateLimit,
  makeFailure,
  type CodexFailure,
} from './errors.js';
import { logInvocation, nowIso } from './logger.js';

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface RunCodexOptions {
  /**
   * Prompt sent to Codex via stdin. Stdin avoids OS argv length limits for
   * long prompts and keeps shell-injection risk at zero.
   */
  prompt: string;
  /** Working directory Codex operates in. Codex requires this to be a git repo unless skipGitCheck is set. */
  cwd?: string;
  /** Sandbox policy passed to `codex exec --sandbox`. */
  sandbox?: SandboxMode;
  /** Additional writable directories beyond cwd. */
  addDirs?: string[];
  /** Override the model Codex uses for this call. */
  model?: string;
  /** Per-call timeout. Falls back to CODEX_MCP_TIMEOUT_MS env var, then 5 minutes. */
  timeoutMs?: number;
  /** Allow running outside a git repo. */
  skipGitCheck?: boolean;
  /** For logging only: identifies the MCP tool that initiated this call. */
  tool: string;
}

export interface RunCodexSuccess {
  ok: true;
  finalMessage: string;
  threadId: string | null;
  events: CodexEvent[];
  exitCode: number;
  stderr: string;
  durationMs: number;
}

export type RunCodexResult = RunCodexSuccess | (CodexFailure & { durationMs: number });

/**
 * The shape of `codex exec --json` events as observed against CLI 0.132.0.
 * Codex emits other event types (turn.started, turn.completed, etc.) that
 * we capture as raw records without strict typing, since the consumer only
 * needs the final agent_message and usage info.
 */
export type CodexEvent =
  | { type: 'thread.started'; thread_id: string }
  | { type: 'turn.started' }
  | { type: 'turn.completed'; usage?: Record<string, number> }
  | {
      type: 'item.completed';
      item: { id: string; type: string; text?: string; [k: string]: unknown };
    }
  | { type: string; [k: string]: unknown };

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const KILL_GRACE_MS = 2000;

function resolveCodexBinary(): string {
  return process.env.CODEX_CLI_PATH ?? 'codex';
}

function resolveTimeout(opts: RunCodexOptions): number {
  if (opts.timeoutMs !== undefined) return opts.timeoutMs;
  const envVal = process.env.CODEX_MCP_TIMEOUT_MS;
  if (envVal) {
    const parsed = Number.parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_TIMEOUT_MS;
}

export function buildCodexArgs(opts: RunCodexOptions): string[] {
  const args = ['exec', '--json'];
  if (opts.sandbox) args.push('--sandbox', opts.sandbox);
  if (opts.cwd) args.push('-C', opts.cwd);
  if (opts.skipGitCheck) args.push('--skip-git-repo-check');
  if (opts.model) args.push('--model', opts.model);
  if (opts.addDirs) {
    for (const d of opts.addDirs) args.push('--add-dir', d);
  }
  // Explicit `-` makes "prompt comes from stdin" part of the argv contract
  // and is future-proof against Codex changing its default-input behavior.
  args.push('-');
  return args;
}

/**
 * Streams Codex's JSONL stdout and accumulates parsed events plus the
 * final agent message. Returns partial buffer at end so caller can detect
 * truncation.
 */
function parseJsonlStream(): {
  push: (chunk: string) => void;
  end: () => { events: CodexEvent[]; finalMessage: string; threadId: string | null; parseFailures: string[] };
} {
  let buffer = '';
  const events: CodexEvent[] = [];
  const parseFailures: string[] = [];
  let finalMessage = '';
  let threadId: string | null = null;

  const processLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const evt = JSON.parse(trimmed) as CodexEvent;
      events.push(evt);
      if (evt.type === 'thread.started' && typeof (evt as { thread_id?: unknown }).thread_id === 'string') {
        threadId = (evt as { thread_id: string }).thread_id;
      }
      if (
        evt.type === 'item.completed' &&
        typeof (evt as { item?: { type?: unknown; text?: unknown } }).item === 'object' &&
        (evt as { item: { type: string } }).item.type === 'agent_message' &&
        typeof (evt as { item: { text?: unknown } }).item.text === 'string'
      ) {
        // Multiple agent_message items can be emitted per turn. Take the last.
        finalMessage = (evt as { item: { text: string } }).item.text;
      }
    } catch {
      parseFailures.push(trimmed.slice(0, 200));
    }
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        processLine(line);
        nl = buffer.indexOf('\n');
      }
    },
    end() {
      if (buffer.length > 0) processLine(buffer);
      return { events, finalMessage, threadId, parseFailures };
    },
  };
}

interface SpawnOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  timedOut: boolean;
  spawnError: NodeJS.ErrnoException | null;
}

async function spawnCodex(
  binary: string,
  args: string[],
  prompt: string,
  timeoutMs: number,
  parser: ReturnType<typeof parseJsonlStream>,
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
      child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
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

    child.stdout.on('data', (chunk: string) => {
      parser.push(chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      stderrBuf += chunk;
    });

    // Codex can exit before consuming the full prompt (auth failure, crash).
    // Without this listener, the resulting EPIPE becomes an unhandled stream
    // error and crashes the MCP host process.
    child.stdin.on('error', () => {
      // Intentional swallow. The actual failure is reported via the close
      // event with the captured stderr.
    });

    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        exitCode,
        signal,
        stderr: stderrBuf,
        timedOut,
        spawnError: null,
      });
    });

    // Stdin must be closed so Codex knows the prompt is complete.
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function summariseArgs(opts: RunCodexOptions): Record<string, unknown> {
  return {
    cwd: opts.cwd ?? null,
    sandbox: opts.sandbox ?? null,
    model: opts.model ?? null,
    promptChars: opts.prompt.length,
    timeoutMs: resolveTimeout(opts),
    skipGitCheck: opts.skipGitCheck ?? false,
    addDirs: opts.addDirs?.length ?? 0,
  };
}

export async function runCodex(opts: RunCodexOptions): Promise<RunCodexResult> {
  const startedAt = Date.now();
  const binary = resolveCodexBinary();
  const args = buildCodexArgs(opts);
  const timeoutMs = resolveTimeout(opts);
  const parser = parseJsonlStream();
  const argSummary = summariseArgs(opts);

  const outcome = await spawnCodex(binary, args, opts.prompt, timeoutMs, parser);
  const durationMs = Date.now() - startedAt;
  const { events, finalMessage, threadId, parseFailures } = parser.end();

  // Spawn-time failures: missing binary, permission denied. These never
  // produced any Codex output, so error class comes from errno.
  if (outcome.spawnError) {
    const code = outcome.spawnError.code;
    // EACCES means the binary exists yet cannot be executed (permission bit
    // on POSIX, file locked on Windows). Same remediation as ENOENT from the
    // caller's perspective: the Codex CLI is unusable.
    if (code === 'ENOENT' || code === 'EACCES') {
      const fail = makeFailure(
        'CODEX_NOT_FOUND',
        `Codex CLI binary not usable (looked for '${binary}'). errno=${code}`,
        outcome.stderr,
        null,
      );
      logInvocation({
        ts: nowIso(),
        tool: opts.tool,
        durationMs,
        exitCode: null,
        errorClass: 'CODEX_NOT_FOUND',
        argSummary,
      });
      return { ...fail, durationMs };
    }
    const fail = makeFailure(
      'CODEX_FAILED',
      `Failed to spawn Codex CLI: ${outcome.spawnError.message}`,
      outcome.stderr,
      null,
    );
    logInvocation({
      ts: nowIso(),
      tool: opts.tool,
      durationMs,
      exitCode: null,
      errorClass: 'CODEX_FAILED',
      argSummary,
    });
    return { ...fail, durationMs };
  }

  if (outcome.timedOut) {
    const fail = makeFailure(
      'CODEX_TIMEOUT',
      `Codex CLI exceeded timeout of ${timeoutMs}ms and was killed.`,
      outcome.stderr,
      outcome.exitCode,
    );
    logInvocation({
      ts: nowIso(),
      tool: opts.tool,
      durationMs,
      exitCode: outcome.exitCode,
      errorClass: 'CODEX_TIMEOUT',
      argSummary,
    });
    return { ...fail, durationMs };
  }

  // Non-zero exit. Classify against known patterns before falling back to generic.
  if (outcome.exitCode !== 0) {
    // Pattern detectors search events as well so a rate-limit or auth message
    // surfaced in a non-agent_message event is still classified correctly.
    // Built lazily because the success path never consults it.
    const eventsSerialised = events.map((e) => JSON.stringify(e)).join('\n');
    const combinedHaystack = `${finalMessage}\n${eventsSerialised}`;
    let errorClass: 'CODEX_NOT_AUTHENTICATED' | 'CODEX_RATE_LIMITED' | 'CODEX_FAILED' =
      'CODEX_FAILED';
    if (looksLikeAuthFailure(outcome.stderr, combinedHaystack)) {
      errorClass = 'CODEX_NOT_AUTHENTICATED';
    } else if (looksLikeRateLimit(outcome.stderr, combinedHaystack)) {
      errorClass = 'CODEX_RATE_LIMITED';
    }
    const fail = makeFailure(
      errorClass,
      `Codex CLI exited with code ${outcome.exitCode}${outcome.signal ? ` (signal ${outcome.signal})` : ''}.`,
      outcome.stderr,
      outcome.exitCode,
    );
    logInvocation({
      ts: nowIso(),
      tool: opts.tool,
      durationMs,
      exitCode: outcome.exitCode,
      errorClass,
      argSummary,
    });
    return { ...fail, durationMs };
  }

  // Exit 0 with no agent_message means Codex completed without producing
  // user-visible output. Possible causes: tool-only turn, interrupted run,
  // upstream output schema change. Returning ok:true with an empty
  // finalMessage would silently hide the failure from the calling agent.
  if (finalMessage === '') {
    const detail =
      events.length === 0
        ? `no parseable JSONL events; ${parseFailures.length} unparseable lines`
        : `${events.length} events received; no agent_message item among them; ${parseFailures.length} unparseable lines`;
    const fail = makeFailure(
      'CODEX_PARSE_ERROR',
      `Codex exited cleanly; no final assistant message was produced (${detail}).`,
      outcome.stderr,
      0,
    );
    logInvocation({
      ts: nowIso(),
      tool: opts.tool,
      durationMs,
      exitCode: 0,
      errorClass: 'CODEX_PARSE_ERROR',
      argSummary,
    });
    return { ...fail, durationMs };
  }

  logInvocation({
    ts: nowIso(),
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
    events,
    exitCode: 0,
    stderr: outcome.stderr,
    durationMs,
  };
}

const PROBE_TIMEOUT_MS = 10000;

/**
 * Lightweight auth probe that does not spawn a full Codex turn. Useful for
 * codex_status and for fail-fast paths before expensive calls. The probe is
 * hard-capped at PROBE_TIMEOUT_MS so a network-bound credential refresh
 * cannot stall the MCP server indefinitely.
 */
export async function probeAuth(): Promise<{ loggedIn: boolean; raw: string }> {
  const binary = resolveCodexBinary();
  return new Promise((resolve) => {
    let stdoutBuf = '';
    let stderrBuf = '';
    let settled = false;
    const settle = (val: { loggedIn: boolean; raw: string }): void => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(binary, ['login', 'status'], { stdio: ['ignore', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
    } catch {
      settle({ loggedIn: false, raw: 'spawn failed' });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already dead. The close handler still fires.
      }
      settle({ loggedIn: false, raw: 'probe timed out' });
    }, PROBE_TIMEOUT_MS);
    child.on('error', () => {
      clearTimeout(timer);
      settle({ loggedIn: false, raw: 'spawn error' });
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (stdoutBuf += c));
    child.stderr.on('data', (c: string) => (stderrBuf += c));
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      const combined = `${stdoutBuf}\n${stderrBuf}`;
      // The 'not logged in' negation would otherwise match a bare /logged in/ pattern.
      const hasNegation = /not\s+logged\s*in/i.test(combined);
      const hasPositive = /(?:^|\W)logged\s+in/i.test(combined);
      const loggedIn = exitCode === 0 && hasPositive && !hasNegation;
      settle({ loggedIn, raw: combined.trim() });
    });
  });
}

export async function probeVersion(): Promise<string | null> {
  const binary = resolveCodexBinary();
  return new Promise((resolve) => {
    let buf = '';
    let settled = false;
    const settle = (val: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(binary, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
    } catch {
      settle(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already dead.
      }
      settle(null);
    }, PROBE_TIMEOUT_MS);
    child.on('error', () => {
      clearTimeout(timer);
      settle(null);
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (buf += c));
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      if (exitCode === 0 && buf.trim()) {
        settle(buf.trim());
      } else {
        settle(null);
      }
    });
  });
}
