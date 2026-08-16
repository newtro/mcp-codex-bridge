/**
 * Provider abstraction for CLI-backed coding agents.
 *
 * The runner in `cli-runner.ts` owns everything that is genuinely shared
 * between CLIs: subprocess spawning, timeout and kill escalation, stream
 * accumulation, error classification, and structured logging. A provider
 * supplies only the parts that actually differ, which is a much smaller
 * surface than it first appears: argv construction, how the prompt is
 * delivered, how the CLI's stdout is turned into a final message, and how
 * its auth and version probes are spelled.
 */

/**
 * Bridge-level sandbox intent. Each provider maps these onto whatever its
 * own CLI calls the equivalent policy, because the vocabularies do not line
 * up: Codex has `workspace-write`, Grok calls the same idea `workspace`.
 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export type ProviderId = 'codex' | 'grok';

export type ErrorKind =
  | 'NOT_FOUND'
  | 'NOT_AUTHENTICATED'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'PARSE_ERROR'
  | 'FAILED';

/**
 * How a prompt reaches the CLI. Codex accepts it on stdin; Grok has no stdin
 * path for single-turn runs and needs `--prompt-file`, so the transport also
 * owns any temp file it created and must be cleaned up by the caller.
 */
export interface PromptTransport {
  /** Args appended after the provider's own flags, e.g. `-` or `--prompt-file <path>`. */
  args: string[];
  /** Text to write to the child's stdin, or null when the prompt travels via a file. */
  stdin: string | null;
  /** Always invoked by the runner, including on failure paths. Must not throw. */
  cleanup: () => Promise<void>;
}

export interface BuildArgsInput {
  sandbox?: SandboxMode;
  cwd?: string;
  model?: string;
  /** Only emitted by providers whose CLI exposes a reasoning-effort flag. */
  reasoningEffort?: string;
  skipGitCheck?: boolean;
  addDirs?: string[];
  /** JSON Schema string. Only emitted by providers with native schema support. */
  jsonSchema?: string;
  maxTurns?: number;
}

export interface ParsedOutput {
  /** The CLI's final assistant message. Empty string means none was produced. */
  finalMessage: string;
  /** Session or thread identifier, when the CLI reports one. */
  threadId: string | null;
  /** Natively parsed structured output, when the CLI supports schema-constrained runs. */
  structured: unknown;
  /** Raw parsed events, kept for error classification and debugging. */
  events: unknown[];
  /** Lines that could not be parsed, truncated for logging. */
  parseFailures: string[];
}

export interface OutputParser {
  push(chunk: string): void;
  end(): ParsedOutput;
}

export interface AuthProbeResult {
  loggedIn: boolean;
  raw: string;
  /**
   * Default model, when the auth probe happens to report it. Grok's `models`
   * command prints it; Codex's `login status` does not, so it falls back to
   * the provider's config file reader.
   */
  defaultModel: string | null;
}

export interface CliProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  /** Error-class prefix, e.g. 'CODEX' produces CODEX_NOT_FOUND. */
  readonly errorPrefix: string;
  readonly binaryEnvVar: string;
  readonly defaultBinary: string;
  readonly timeoutEnvVar: string;

  readonly installHint: string;
  readonly loginHint: string;
  readonly parseErrorHint: string;

  /** True when the CLI can constrain its final answer to a JSON Schema. */
  readonly supportsJsonSchema: boolean;
  /** True when the CLI takes reasoning effort as a per-call flag. */
  readonly supportsReasoningEffort: boolean;

  /** Patterns that mark an auth failure in stderr or event output. */
  readonly authPatterns: readonly RegExp[];
  readonly versionArgs: readonly string[];
  readonly authProbeArgs: readonly string[];

  buildArgs(input: BuildArgsInput): string[];
  preparePrompt(prompt: string): Promise<PromptTransport>;
  createParser(): OutputParser;
  interpretAuthProbe(stdout: string, stderr: string, exitCode: number | null): AuthProbeResult;
  /** Reads the CLI's configured default model from its own config file. */
  readDefaultModel(): Promise<string | null>;
}
