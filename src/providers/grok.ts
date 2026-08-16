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
  SandboxMode,
} from './types.js';

/**
 * Shape of the single object emitted by `grok --output-format json`, as
 * observed against Grok Build 1.0.4. Unlike Codex, Grok does not stream
 * NDJSON in this mode: it prints one pretty-printed object at the end.
 */
interface GrokResult {
  text?: string;
  stopReason?: string;
  sessionId?: string;
  requestId?: string;
  thought?: string;
  usage?: Record<string, number>;
  num_turns?: number;
  total_cost_usd?: number;
  structuredOutput?: unknown;
  [k: string]: unknown;
}

/**
 * Read-only tool allowlist.
 *
 * This is load-bearing rather than belt-and-braces. Grok's `--sandbox`
 * enforcement is built on Landlock (Linux) and Seatbelt (macOS); on Windows
 * the profile cannot be applied, and the documented behavior is to log a
 * warning and continue WITHOUT enforcement. An unrecognised profile name is
 * likewise accepted silently rather than rejected. So on the platform this
 * bridge actually runs on, `--sandbox read-only` alone would leave the agent
 * free to edit files during what the caller believes is a review.
 *
 * `--tools` is applied by the CLI itself when assembling the agent's toolset,
 * which is platform-independent. Restricting to these three removes
 * search_replace and run_terminal_cmd outright, so a read-only run has no
 * write capability regardless of whether the OS sandbox engaged.
 */
const READ_ONLY_TOOLS = 'read_file,grep,list_dir';

/**
 * Explicit denylist layered on top of the allowlist above.
 *
 * The allowlist alone is not sufficient. Verified against Grok Build 1.0.4:
 * with `--tools read_file,grep,list_dir` the agent still reported holding
 * `search_tool` and `use_tool`, the MCP discovery and invocation pair. Those
 * are harmless while no MCP servers are configured, but they are a write path
 * the moment one is, and it would not be visible at this call site.
 *
 * The Grok docs specify that `--disallowed-tools` is applied after `--tools`
 * precisely so an allowlist can be further narrowed, so naming them here is
 * the documented way to close the gap.
 */
const READ_ONLY_DENIED_TOOLS = 'search_replace,run_terminal_cmd,search_tool,use_tool,Agent';

/** Built-in profiles accepted by `--sandbox`. Custom profiles from sandbox.toml are also valid. */
const KNOWN_SANDBOX_PROFILES = new Set(['off', 'workspace', 'read-only', 'strict']);

function grokSandboxArgs(mode: SandboxMode | undefined): string[] {
  switch (mode) {
    case 'read-only':
      return [
        '--sandbox',
        'read-only',
        '--tools',
        READ_ONLY_TOOLS,
        '--disallowed-tools',
        READ_ONLY_DENIED_TOOLS,
      ];
    case 'workspace-write':
      // Headless runs cannot answer an approval prompt; without this the run
      // would block until the bridge's own timeout kills it.
      return ['--sandbox', 'workspace', '--always-approve'];
    case 'danger-full-access':
      return ['--sandbox', 'off', '--always-approve'];
    default:
      return [];
  }
}

/**
 * Grok prints one JSON object rather than a stream, so the parser buffers
 * everything and decodes once. The object is located by its outer braces so
 * that an update notice or sandbox warning printed before it does not break
 * the decode.
 */
function createGrokParser(): OutputParser {
  let buffer = '';
  return {
    push(chunk: string): void {
      buffer += chunk;
    },
    end(): ParsedOutput {
      const trimmed = buffer.trim();
      if (!trimmed) {
        return {
          finalMessage: '',
          threadId: null,
          structured: null,
          events: [],
          parseFailures: [],
        };
      }
      const start = trimmed.indexOf('{');
      const stop = trimmed.lastIndexOf('}');
      if (start === -1 || stop <= start) {
        return {
          finalMessage: '',
          threadId: null,
          structured: null,
          events: [],
          parseFailures: [trimmed.slice(0, 200)],
        };
      }
      try {
        const obj = JSON.parse(trimmed.slice(start, stop + 1)) as GrokResult;
        return {
          finalMessage: typeof obj.text === 'string' ? obj.text : '',
          threadId: typeof obj.sessionId === 'string' ? obj.sessionId : null,
          structured: obj.structuredOutput ?? null,
          events: [obj],
          parseFailures: [],
        };
      } catch {
        return {
          finalMessage: '',
          threadId: null,
          structured: null,
          events: [],
          parseFailures: [trimmed.slice(0, 200)],
        };
      }
    },
  };
}

/** Grok's config lives at ~/.grok/config.toml with the model under [models]. */
async function readGrokDefaultModel(): Promise<string | null> {
  const grokHome = process.env.GROK_HOME ?? path.join(os.homedir(), '.grok');
  const configPath = path.join(grokHome, 'config.toml');
  let content: string;
  try {
    content = await fs.readFile(configPath, 'utf8');
  } catch {
    return null;
  }
  // Unlike Codex, the key is namespaced under a [models] section, so the
  // reader tracks the current section rather than stopping at the first one.
  let section = '';
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    const header = /^\[([^\]]+)\]/.exec(trimmed);
    if (header && header[1]) {
      section = header[1];
      continue;
    }
    if (section !== 'models') continue;
    const match = /^default\s*=\s*["']([^"']+)["']/.exec(trimmed);
    if (match && match[1]) return match[1];
  }
  return null;
}

export const grokProvider: CliProvider = {
  id: 'grok',
  displayName: 'Grok Build',
  errorPrefix: 'GROK',
  binaryEnvVar: 'GROK_CLI_PATH',
  defaultBinary: 'grok',
  timeoutEnvVar: 'GROK_MCP_TIMEOUT_MS',

  installHint:
    'Install Grok Build (curl -fsSL https://x.ai/cli/install.sh | bash) or set GROK_CLI_PATH to the absolute path of grok.exe. The installer puts it in ~/.grok/bin, which is not on PATH by default on Windows.',
  loginHint: 'Run `grok login` to sign in with your SuperGrok or X Premium+ account, then retry.',
  parseErrorHint:
    'The Grok CLI emitted output this bridge could not parse. Run `grok version` to check for a CLI upgrade; the bridge expects a single JSON object from --output-format json.',

  supportsJsonSchema: true,
  supportsReasoningEffort: true,

  authPatterns: [
    /not\s+logged\s*in/i,
    /please\s+(?:run\s+)?["']?grok\s+login["']?/i,
    /authentication\s+(?:failed|required)/i,
    /no\s+(?:credentials|auth\s+token)/i,
    /401\s+unauthorized/i,
    /sign\s+in\s+to\s+grok/i,
  ],
  versionArgs: ['--version'],
  // `grok models` requires a valid session and reports the default model in
  // the same breath, so one probe answers both questions Codex needs two for.
  authProbeArgs: ['models'],

  buildArgs(opts: BuildArgsInput): string[] {
    const args: string[] = ['--output-format', 'json'];
    args.push(...grokSandboxArgs(opts.sandbox));
    if (opts.cwd) args.push('--cwd', opts.cwd);
    if (opts.model) args.push('--model', opts.model);
    if (opts.reasoningEffort) args.push('--reasoning-effort', opts.reasoningEffort);
    if (opts.maxTurns !== undefined) args.push('--max-turns', String(opts.maxTurns));
    if (opts.jsonSchema) args.push('--json-schema', opts.jsonSchema);
    // `skipGitCheck` and `addDirs` have no Grok equivalent: Grok does not
    // require a git repo, and extra writable paths are configured through
    // sandbox.toml rather than argv. Both are intentionally ignored.
    return args;
  },

  async preparePrompt(prompt: string): Promise<PromptTransport> {
    // Grok has no stdin path for single-turn runs. `-p` would work but puts
    // the whole prompt in argv, and a PR diff blows past the ~32 KB Windows
    // command-line limit. --prompt-file keeps arbitrarily large prompts safe.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-bridge-'));
    const file = path.join(dir, 'prompt.txt');
    await fs.writeFile(file, prompt, 'utf8');
    return {
      args: ['--prompt-file', file],
      stdin: null,
      cleanup: async () => {
        try {
          await fs.rm(dir, { recursive: true, force: true });
        } catch {
          // A leftover temp file must never turn a successful run into a
          // failure. The OS reclaims it on the next tmp sweep.
        }
      },
    };
  },

  createParser: createGrokParser,

  interpretAuthProbe(stdout: string, stderr: string, exitCode: number | null): AuthProbeResult {
    const combined = `${stdout}\n${stderr}`;
    const hasNegation = /not\s+logged\s*in|sign\s+in\s+to\s+grok/i.test(combined);
    const hasPositive = /you\s+are\s+logged\s+in|(?:^|\W)logged\s+in\s+with/i.test(combined);
    const modelMatch = /^\s*Default model:\s*(\S+)/im.exec(combined);
    return {
      loggedIn: exitCode === 0 && hasPositive && !hasNegation,
      raw: combined.trim(),
      defaultModel: modelMatch?.[1] ?? null,
    };
  },

  readDefaultModel: readGrokDefaultModel,
};

export { KNOWN_SANDBOX_PROFILES, READ_ONLY_DENIED_TOOLS, READ_ONLY_TOOLS };
