import type { CliProvider, ErrorKind } from './providers/types.js';

/**
 * CLI failure modes the calling agent needs to distinguish. Every class
 * carries a `userAction` so the agent can decide whether to retry, fall back
 * to another reviewer, or escalate to the human without inspecting raw
 * stderr.
 *
 * Classes are namespaced per provider (CODEX_TIMEOUT, GROK_TIMEOUT) so a
 * caller running several CLIs in parallel can tell which one degraded. The
 * CODEX_* spellings are unchanged from the single-provider version of this
 * bridge, so existing consumers keep working.
 */
export type CodexErrorClass = `CODEX_${ErrorKind}`;
export type GrokErrorClass = `GROK_${ErrorKind}`;
export type CliErrorClass = CodexErrorClass | GrokErrorClass;

export interface CliFailure {
  ok: false;
  errorClass: CliErrorClass;
  message: string;
  userAction: string;
  stderr: string;
  exitCode: number | null;
}

/** Retained under the original name so downstream imports do not break. */
export type CodexFailure = CliFailure;

function userActionFor(provider: CliProvider, kind: ErrorKind): string {
  switch (kind) {
    case 'NOT_FOUND':
      return provider.installHint;
    case 'NOT_AUTHENTICATED':
      return provider.loginHint;
    case 'RATE_LIMITED':
      return `Wait a few minutes and retry. If this persists, check your ${provider.displayName} plan usage limits.`;
    case 'TIMEOUT':
      return `Retry with a larger timeout (${provider.timeoutEnvVar} env var, or per-call timeout_ms argument), or break the request into smaller steps.`;
    case 'PARSE_ERROR':
      return provider.parseErrorHint;
    case 'FAILED':
      return `Read the stderr field for the underlying error message from ${provider.displayName} itself.`;
  }
}

export function makeFailure(
  provider: CliProvider,
  kind: ErrorKind,
  message: string,
  stderr = '',
  exitCode: number | null = null,
): CliFailure {
  return {
    ok: false,
    errorClass: `${provider.errorPrefix}_${kind}` as CliErrorClass,
    message,
    userAction: userActionFor(provider, kind),
    stderr,
    exitCode,
  };
}

export function looksLikeAuthFailure(
  provider: CliProvider,
  stderr: string,
  stdout: string,
): boolean {
  const haystack = `${stderr}\n${stdout}`;
  return provider.authPatterns.some((pat) => pat.test(haystack));
}

/**
 * Rate-limit wording is close enough across vendors that a shared pattern set
 * is more maintainable than per-provider copies. If a provider ever needs its
 * own, promote this to the CliProvider interface the way authPatterns is.
 */
const RATE_LIMIT_PATTERNS: RegExp[] = [
  /rate[\s-]?limit/i,
  /quota\s+exceeded/i,
  /too\s+many\s+requests/i,
  /429/,
  /usage\s+limit\s+reached/i,
];

export function looksLikeRateLimit(stderr: string, stdout: string): boolean {
  const haystack = `${stderr}\n${stdout}`;
  return RATE_LIMIT_PATTERNS.some((pat) => pat.test(haystack));
}
