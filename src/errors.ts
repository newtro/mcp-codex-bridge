/**
 * Codex CLI failure modes that the calling agent needs to distinguish.
 * Every class includes a `userAction` so the agent can decide whether to
 * retry, fall back, or escalate to the human without having to inspect
 * raw stderr.
 */
export type CodexErrorClass =
  | 'CODEX_NOT_FOUND'
  | 'CODEX_NOT_AUTHENTICATED'
  | 'CODEX_RATE_LIMITED'
  | 'CODEX_TIMEOUT'
  | 'CODEX_PARSE_ERROR'
  | 'CODEX_FAILED';

export interface CodexFailure {
  ok: false;
  errorClass: CodexErrorClass;
  message: string;
  userAction: string;
  stderr: string;
  exitCode: number | null;
}

const USER_ACTIONS: Record<CodexErrorClass, string> = {
  CODEX_NOT_FOUND:
    'Install Codex CLI (https://github.com/openai/codex) or set CODEX_CLI_PATH to its absolute path.',
  CODEX_NOT_AUTHENTICATED:
    'Run `codex login` to sign in with your ChatGPT account, then retry.',
  CODEX_RATE_LIMITED:
    'Wait a few minutes and retry. If this persists, check your ChatGPT plan usage limits.',
  CODEX_TIMEOUT:
    'Retry with a larger timeout (CODEX_MCP_TIMEOUT_MS env var, or per-call timeout_ms argument), or break the request into smaller steps.',
  CODEX_PARSE_ERROR:
    'The Codex CLI emitted output this bridge could not parse. Run `codex --version` to check for a CLI upgrade; the bridge may need updating to match a new event schema.',
  CODEX_FAILED:
    'Read the stderr field for the underlying error message from Codex itself.',
};

export function makeFailure(
  errorClass: CodexErrorClass,
  message: string,
  stderr = '',
  exitCode: number | null = null,
): CodexFailure {
  return {
    ok: false,
    errorClass,
    message,
    userAction: USER_ACTIONS[errorClass],
    stderr,
    exitCode,
  };
}

/**
 * Codex prints "Not logged in" style messages to stderr when auth is missing.
 * The exact string has shifted across CLI versions, so the detector matches
 * against several known patterns to stay resilient to upstream wording changes.
 */
const AUTH_PATTERNS: RegExp[] = [
  /not\s+logged\s*in/i,
  /please\s+(?:run\s+)?["']?codex\s+login["']?/i,
  /authentication\s+(?:failed|required)/i,
  /no\s+(?:credentials|auth\s+token)/i,
  /401\s+unauthorized/i,
];

export function looksLikeAuthFailure(stderr: string, stdout: string): boolean {
  const haystack = `${stderr}\n${stdout}`;
  return AUTH_PATTERNS.some((pat) => pat.test(haystack));
}

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
