import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AuthProbeResult,
  BuildArgsInput,
  CliProvider,
  OutputParser,
  ParsedOutput,
  PromptTransport,
} from './types.js';

/**
 * The shape of `codex exec --json` events as observed against CLI 0.132.0
 * through 0.144.5. Codex emits other event types (turn.started,
 * turn.completed, etc.) that are captured as raw records without strict
 * typing, since the consumer only needs the final agent_message.
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

/**
 * Codex streams newline-delimited JSON, so the parser is incremental: it
 * holds a partial line across chunk boundaries and only emits once a newline
 * arrives. The trailing partial (if any) is processed at end().
 */
function createCodexParser(): OutputParser {
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
      if (
        evt.type === 'thread.started' &&
        typeof (evt as { thread_id?: unknown }).thread_id === 'string'
      ) {
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
    push(chunk: string): void {
      buffer += chunk;
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        processLine(line);
        nl = buffer.indexOf('\n');
      }
    },
    end(): ParsedOutput {
      if (buffer.length > 0) processLine(buffer);
      // Codex has no schema-constrained mode, so structured output is always
      // null. Callers needing JSON ask for it in the prompt text instead.
      return { events, finalMessage, threadId, structured: null, parseFailures };
    },
  };
}

/**
 * Codex stores its default model in ~/.codex/config.toml as `model = "..."`.
 * A full TOML parser is overkill for a single key and would add a transitive
 * dependency to read one line. The narrow regex tolerates surrounding
 * whitespace, quote style, and comments.
 *
 * CODEX_HOME is resolved on each call so tests and runtime overrides take
 * effect after module load.
 */
async function readCodexDefaultModel(): Promise<string | null> {
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const configPath = path.join(codexHome, 'config.toml');
  let content: string;
  try {
    content = await fs.readFile(configPath, 'utf8');
  } catch {
    return null;
  }
  // Match top-level `model = "..."` only. A bracketed section (e.g.
  // [profile.foo]) appearing before the key would put it inside that section.
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) break;
    const match = /^model\s*=\s*["']([^"']+)["']/.exec(trimmed);
    if (match && match[1]) return match[1];
  }
  return null;
}

export const codexProvider: CliProvider = {
  id: 'codex',
  displayName: 'Codex',
  errorPrefix: 'CODEX',
  binaryEnvVar: 'CODEX_CLI_PATH',
  defaultBinary: 'codex',
  timeoutEnvVar: 'CODEX_MCP_TIMEOUT_MS',

  installHint:
    'Install Codex CLI (https://github.com/openai/codex) or set CODEX_CLI_PATH to its absolute path.',
  loginHint: 'Run `codex login` to sign in with your ChatGPT account, then retry.',
  parseErrorHint:
    'The Codex CLI emitted output this bridge could not parse. Run `codex --version` to check for a CLI upgrade; the bridge may need updating to match a new event schema.',

  supportsJsonSchema: false,
  // Codex takes reasoning effort from config.toml (model_reasoning_effort),
  // not from an exec flag, so per-call override is not available here.
  supportsReasoningEffort: false,

  authPatterns: [
    /not\s+logged\s*in/i,
    /please\s+(?:run\s+)?["']?codex\s+login["']?/i,
    /authentication\s+(?:failed|required)/i,
    /no\s+(?:credentials|auth\s+token)/i,
    /401\s+unauthorized/i,
  ],
  versionArgs: ['--version'],
  authProbeArgs: ['login', 'status'],

  buildArgs(opts: BuildArgsInput): string[] {
    const args = ['exec', '--json'];
    if (opts.sandbox) args.push('--sandbox', opts.sandbox);
    if (opts.cwd) args.push('-C', opts.cwd);
    if (opts.skipGitCheck) args.push('--skip-git-repo-check');
    if (opts.model) args.push('--model', opts.model);
    if (opts.addDirs) {
      for (const d of opts.addDirs) args.push('--add-dir', d);
    }
    return args;
  },

  async preparePrompt(prompt: string): Promise<PromptTransport> {
    // Explicit `-` makes "prompt comes from stdin" part of the argv contract
    // and is future-proof against Codex changing its default-input behavior.
    // Stdin also sidesteps OS argv length limits entirely.
    return {
      args: ['-'],
      stdin: prompt,
      cleanup: async () => {
        /* nothing to clean up: the prompt never touched disk */
      },
    };
  },

  createParser: createCodexParser,

  interpretAuthProbe(stdout: string, stderr: string, exitCode: number | null): AuthProbeResult {
    const combined = `${stdout}\n${stderr}`;
    // The 'not logged in' negation would otherwise match a bare /logged in/.
    const hasNegation = /not\s+logged\s*in/i.test(combined);
    const hasPositive = /(?:^|\W)logged\s+in/i.test(combined);
    return {
      loggedIn: exitCode === 0 && hasPositive && !hasNegation,
      raw: combined.trim(),
      defaultModel: null,
    };
  },

  readDefaultModel: readCodexDefaultModel,
};
