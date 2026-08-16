import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { RunCliResult } from './cli-runner.js';
import { getProvider, PROVIDER_IDS } from './providers/index.js';
import type { ProviderId } from './providers/types.js';
import { formatStatus, getStatus } from './tools/status.js';
import { runAsk } from './tools/ask.js';
import { runReview } from './tools/review.js';
import { runImplement, type ImplementResult } from './tools/implement.js';

export const SERVER_NAME = 'mcp-codex-bridge';
export const SERVER_VERSION = '0.2.0';

function toolResultFrom(result: RunCliResult): {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
} {
  if (result.ok) {
    // When the CLI decoded a schema-constrained answer natively, hand back the
    // re-serialized object rather than the raw text. It is guaranteed valid
    // JSON, so the caller never has to strip a stray code fence or preamble.
    const text =
      result.structured !== null && result.structured !== undefined
        ? JSON.stringify(result.structured, null, 2)
        : result.finalMessage;
    return { content: [{ type: 'text', text }] };
  }
  // MCP clients see isError:true and can decide whether to surface to the user
  // or retry. The text body carries the actionable remediation.
  const body = [
    `[${result.errorClass}] ${result.message}`,
    `User action: ${result.userAction}`,
    result.stderr.trim() ? `\nStderr:\n${result.stderr.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return { content: [{ type: 'text', text: body }], isError: true };
}

function implementResultToToolResult(result: ImplementResult): {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
} {
  const base = toolResultFrom(result.codex);
  // Append an objective post-run summary so the calling agent has a source of
  // truth independent of the CLI's self-reported description.
  const lines: string[] = [];
  if (result.filesChanged === null) {
    lines.push('Post-run git probe: unavailable (not a git repo, git missing, or probe failed).');
  } else if (result.filesChanged.length === 0) {
    lines.push('Post-run git probe: no files changed since HEAD.');
  } else {
    lines.push(`Post-run git probe: ${result.filesChanged.length} file(s) changed since HEAD:`);
    for (const f of result.filesChanged) lines.push(`  - ${f}`);
  }
  if (result.diffStat && result.diffStat.length > 0) {
    lines.push('');
    lines.push('git diff --stat HEAD:');
    lines.push(result.diffStat);
  }
  const appendage = '\n\n---\n' + lines.join('\n');
  const merged = base.content.map((c, i) => (i === 0 ? { ...c, text: c.text + appendage } : c));
  return { ...base, content: merged };
}

/**
 * Tools are registered per provider rather than behind a single `provider`
 * enum argument. Explicit names (`grok_review` vs `codex_review`) let a caller
 * fan out to several reviewers by naming them directly, keep the existing
 * `codex_*` contract byte-identical for current consumers, and make the choice
 * of backend visible in the transcript instead of buried in an argument.
 */
function registerProviderTools(server: McpServer, id: ProviderId): void {
  const provider = getProvider(id);
  const name = provider.displayName;

  // Declared for every provider so the tool shapes stay uniform, but the
  // runner drops it for CLIs without a per-call flag. Codex takes reasoning
  // effort from config.toml only, so saying so here stops a caller from
  // assuming an override landed when it silently did not.
  const effortDescription = provider.supportsReasoningEffort
    ? `Reasoning effort for this call (e.g. "low", "high", "xhigh"). Passed straight to the ${name} CLI.`
    : `Ignored: the ${name} CLI takes reasoning effort from its own config file, not a per-call flag. Set it there instead.`;
  const reasoningEffortField = z.string().optional().describe(effortDescription);

  server.registerTool(
    `${id}_status`,
    {
      title: `${name} Status`,
      description: `Reports whether the ${name} CLI is installed, signed in, and ready. Use this when a previous ${name} call failed, or before a long-running task to fail fast on auth issues.`,
      inputSchema: {},
    },
    async () => {
      const status = await getStatus(id);
      return { content: [{ type: 'text', text: formatStatus(status) }] };
    },
  );

  server.registerTool(
    `${id}_ask`,
    {
      title: `${name} Ask`,
      description: `Sends a general-purpose query to ${name} for a second opinion or analysis. Read-only. Use when the task is open-ended or does not fit code review or implementation.`,
      inputSchema: {
        prompt: z.string().min(1).describe(`The question or analysis request for ${name}.`),
        working_directory: z
          .string()
          .optional()
          .describe('Optional cwd. If omitted, the CLI runs in the host process cwd.'),
        context_files: z
          .array(z.string())
          .optional()
          .describe(
            'Optional list of files to include as context. Each is read and prepended to the prompt; files over 64 KiB are truncated.',
          ),
        model: z.string().optional().describe(`Override the model for this call.`),
        reasoning_effort: reasoningEffortField,
        timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Per-call timeout in ms. Defaults to ${provider.timeoutEnvVar} or 300000.`),
      },
    },
    async (args) => toolResultFrom(await runAsk(args, id)),
  );

  server.registerTool(
    `${id}_review`,
    {
      title: `${name} Review`,
      description:
        `Hands ${name} a diff or file content for adversarial review, in a read-only sandbox. ` +
        `By default returns markdown classified as BLOCKER / MAJOR / MINOR with file:line evidence. ` +
        `Set structured:true to get machine-readable JSON findings instead, which is what you want when ` +
        `reconciling this review against other reviewers.` +
        (provider.supportsJsonSchema
          ? ` ${name} constrains the response to the schema natively, so the JSON is guaranteed well formed.`
          : ` ${name} has no native schema mode, so the schema is enforced through the prompt.`),
      inputSchema: {
        diff: z.string().min(1).describe('Unified diff or full file content to review.'),
        focus_areas: z
          .array(z.string())
          .optional()
          .describe('Concerns to weight heavily, e.g. ["security", "performance", "edge cases"].'),
        context: z
          .string()
          .optional()
          .describe(
            'What the code is trying to do, plus any project conventions, so the reviewer can judge intent vs. behavior.',
          ),
        structured: z
          .boolean()
          .optional()
          .describe(
            'Return JSON findings (file, line, severity, category, evidence, issue, suggested_fix, confidence) instead of markdown. Use this for multi-reviewer reconciliation.',
          ),
        output_schema: z
          .string()
          .optional()
          .describe('Custom JSON Schema as a string. Implies structured:true and overrides the built-in findings schema.'),
        working_directory: z
          .string()
          .optional()
          .describe('Optional cwd the CLI reads referenced files from.'),
        model: z.string().optional().describe('Override the model for this call.'),
        reasoning_effort: reasoningEffortField,
        timeout_ms: z.number().int().positive().optional(),
      },
    },
    async (args) => toolResultFrom(await runReview(args, id)),
  );

  server.registerTool(
    `${id}_implement`,
    {
      title: `${name} Implement`,
      description: `Hands ${name} a specification and asks it to produce an implementation. Defaults to a workspace-write sandbox so it can edit files in the working directory. Use when delegating a focused sub-task.`,
      inputSchema: {
        spec: z.string().min(1).describe('Specification describing what to build.'),
        working_directory: z
          .string()
          .min(1)
          .describe(
            'Absolute path of the repository to modify. Required because the CLI must know which checkout to write into.',
          ),
        files_in_scope: z
          .array(z.string())
          .optional()
          .describe('Optional list of files the CLI is encouraged to limit its edits to.'),
        approval_mode: z
          .enum(['read-only', 'workspace-write', 'danger-full-access'])
          .optional()
          .describe(
            'Sandbox policy. Defaults to workspace-write. Use read-only for plan-only runs; use danger-full-access only when the CLI needs to install packages or run commands beyond the workspace.',
          ),
        model: z.string().optional().describe('Override the model for this call.'),
        reasoning_effort: reasoningEffortField,
        timeout_ms: z.number().int().positive().optional(),
      },
    },
    async (args) => {
      try {
        return implementResultToToolResult(await runImplement(args, id));
      } catch (err) {
        // Validation errors from runImplement (e.g. missing working_directory)
        // never reach the CLI; they surface here. Turn them into a tool-level
        // error so the calling agent gets a clear message.
        return {
          content: [{ type: 'text', text: `[BRIDGE_INPUT_ERROR] ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}

export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  for (const id of PROVIDER_IDS) registerProviderTools(server, id);
  return server;
}
