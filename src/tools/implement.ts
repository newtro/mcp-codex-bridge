import crossSpawn from 'cross-spawn';
import { runCodex, type RunCodexResult, type SandboxMode } from '../codex-runner.js';

export interface ImplementInput {
  spec: string;
  working_directory: string;
  files_in_scope?: string[];
  approval_mode?: SandboxMode;
  timeout_ms?: number;
}

export interface ImplementResult {
  codex: RunCodexResult;
  /**
   * Files modified, observed via `git diff --name-only HEAD` after the run.
   * `null` means git was not available, the directory was not a repo, or the
   * diff command failed. An empty array means git ran but reported no changes.
   */
  filesChanged: string[] | null;
  /** Raw `git diff --stat HEAD` output, useful for quick visual scanning. */
  diffStat: string | null;
}

const GIT_TIMEOUT_MS = 5000;

/**
 * Codex's own self-reported summary tells the caller what it claims to have
 * done. Running `git diff` after the turn gives an objective second source
 * of truth that the caller can compare against. Failures here never block
 * the caller; both fields fall back to null so a non-git working dir or a
 * missing git binary do not turn a successful implement into a tool error.
 */
async function gitProbe(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let buf = '';
    let settled = false;
    const settle = (v: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    let child;
    try {
      child = crossSpawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      settle(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child!.kill('SIGKILL');
      } catch {
        // Already dead. Resolve null below.
      }
      settle(null);
    }, GIT_TIMEOUT_MS);
    child.on('error', () => {
      clearTimeout(timer);
      settle(null);
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => (buf += c));
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      settle(exitCode === 0 ? buf : null);
    });
  });
}

async function captureGitDelta(
  cwd: string,
): Promise<{ filesChanged: string[] | null; diffStat: string | null }> {
  // `git diff HEAD` covers tracked modifications and deletions but skips
  // new untracked files. `ls-files --others --exclude-standard` covers the
  // untracked-new case. Both are needed because Codex commonly creates new
  // files as part of an implementation.
  const [tracked, untracked, stat] = await Promise.all([
    gitProbe(cwd, ['diff', '--name-only', 'HEAD']),
    gitProbe(cwd, ['ls-files', '--others', '--exclude-standard']),
    gitProbe(cwd, ['diff', '--stat', 'HEAD']),
  ]);
  if (tracked === null && untracked === null) {
    return { filesChanged: null, diffStat: null };
  }
  const split = (s: string | null): string[] =>
    s === null
      ? []
      : s
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
  const merged = Array.from(new Set([...split(tracked), ...split(untracked)])).sort();
  return { filesChanged: merged, diffStat: stat === null ? null : stat.trim() || '' };
}

export function composeImplementPrompt(input: ImplementInput): string {
  const parts: string[] = [];
  parts.push(
    'You are implementing a change against a real codebase. Apply the change with concrete file edits. Produce real code in the affected files.',
  );
  parts.push('');
  if (input.files_in_scope && input.files_in_scope.length > 0) {
    parts.push('## Files in scope (only modify these)');
    for (const f of input.files_in_scope) parts.push(`- ${f}`);
    parts.push('');
  }
  parts.push('## Specification');
  parts.push(input.spec);
  parts.push('');
  parts.push('## When you finish');
  parts.push(
    'Summarize the changes you made: every file touched, a one-line description of the change in each, and any followup work the caller should know about.',
  );
  return parts.join('\n');
}

export async function runImplement(input: ImplementInput): Promise<ImplementResult> {
  if (!input.working_directory || input.working_directory.trim() === '') {
    throw new Error(
      "codex_implement requires 'working_directory' so Codex knows which checkout to modify. Pass the absolute path of the target repository.",
    );
  }
  const prompt = composeImplementPrompt(input);
  const codex = await runCodex({
    tool: 'codex_implement',
    prompt,
    cwd: input.working_directory,
    sandbox: input.approval_mode ?? 'workspace-write',
    skipGitCheck: false,
    timeoutMs: input.timeout_ms,
  });
  // Always probe the workspace afterwards, even on Codex failure: a partial
  // run may still have edited files the caller needs to know about.
  const { filesChanged, diffStat } = await captureGitDelta(input.working_directory);
  return { codex, filesChanged, diffStat };
}
