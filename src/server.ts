import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { RunCodexResult } from './codex-runner.js';
import { formatStatus, getStatus } from './tools/status.js';
import { runAsk } from './tools/ask.js';
import { runReview } from './tools/review.js';
import { runImplement, type ImplementResult } from './tools/implement.js';

export const SERVER_NAME = 'mcp-codex-bridge';
export const SERVER_VERSION = '0.1.0';

function toolResultFromCodex(result: RunCodexResult): {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
} {
  if (result.ok) {
    return {
      content: [{ type: 'text', text: result.finalMessage }],
    };
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
  return {
    content: [{ type: 'text', text: body }],
    isError: true,
  };
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  server.registerTool(
    'codex_status',
    {
      title: 'Codex Status',
      description:
        'Reports whether the Codex CLI is installed, signed in, and ready to handle requests. Use this when a previous Codex call failed or before a long-running implement task to fail fast on auth issues.',
      inputSchema: {},
    },
    async () => {
      const status = await getStatus();
      return {
        content: [{ type: 'text', text: formatStatus(status) }],
      };
    },
  );

  server.registerTool(
    'codex_ask',
    {
      title: 'Codex Ask',
      description:
        'Sends a general-purpose query to Codex for a second opinion or analysis. Read-only by default. Use when the task is open-ended or does not fit code review or implementation.',
      inputSchema: {
        prompt: z.string().min(1).describe('The question or analysis request for Codex.'),
        working_directory: z
          .string()
          .optional()
          .describe('Optional cwd. If omitted, Codex runs in the host process cwd.'),
        context_files: z
          .array(z.string())
          .optional()
          .describe(
            'Optional list of files to include as context. Each file is read and prepended to the prompt; files over 64 KiB are truncated.',
          ),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Optional per-call timeout in milliseconds. Defaults to CODEX_MCP_TIMEOUT_MS or 300000.'),
      },
    },
    async (args) => {
      const result = await runAsk(args);
      return toolResultFromCodex(result);
    },
  );

  server.registerTool(
    'codex_review',
    {
      title: 'Codex Review',
      description:
        'Hands Codex a diff or file content for adversarial review. Returns issues classified as BLOCKER, MAJOR, MINOR with file:line evidence. Read-only sandbox.',
      inputSchema: {
        diff: z.string().min(1).describe('Unified diff or full file content to review.'),
        focus_areas: z
          .array(z.string())
          .optional()
          .describe('Concerns to weight heavily, e.g. ["security", "performance", "edge cases"].'),
        context: z
          .string()
          .optional()
          .describe('Description of what the code is trying to do, so the reviewer can judge intent vs. behavior.'),
        working_directory: z.string().optional().describe('Optional cwd Codex operates from when reading referenced files.'),
        timeout_ms: z.number().int().positive().optional(),
      },
    },
    async (args) => {
      const result = await runReview(args);
      return toolResultFromCodex(result);
    },
  );

  server.registerTool(
    'codex_implement',
    {
      title: 'Codex Implement',
      description:
        'Hands Codex a specification and asks it to produce an implementation. Defaults to workspace-write sandbox so Codex can edit files in the working directory. Use when delegating a focused sub-task to Codex.',
      inputSchema: {
        spec: z.string().min(1).describe('Specification describing what to build.'),
        working_directory: z
          .string()
          .min(1)
          .describe(
            "Absolute path of the repository Codex should modify. Required because Codex must know which checkout to write into.",
          ),
        files_in_scope: z
          .array(z.string())
          .optional()
          .describe('Optional list of files Codex is encouraged to limit its edits to.'),
        approval_mode: z
          .enum(['read-only', 'workspace-write', 'danger-full-access'])
          .optional()
          .describe(
            'Sandbox policy passed through to Codex. Defaults to workspace-write. Use read-only for plan-only runs; use danger-full-access only when Codex needs to install packages or run commands beyond the workspace.',
          ),
        timeout_ms: z.number().int().positive().optional(),
      },
    },
    async (args) => {
      try {
        const result = await runImplement(args);
        return implementResultToToolResult(result);
      } catch (err) {
        // Validation errors from runImplement (e.g., missing working_directory)
        // never reach Codex; they surface here. The handler turns them into a
        // tool-level error so the calling agent gets a clear message.
        return {
          content: [{ type: 'text', text: `[CODEX_BRIDGE_INPUT_ERROR] ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}

function implementResultToToolResult(result: ImplementResult): {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
} {
  const base = toolResultFromCodex(result.codex);
  // Append an objective post-run summary so the calling agent has a source
  // of truth independent of Codex's self-reported description.
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
  const merged = base.content.map((c, i) =>
    i === 0 ? { ...c, text: c.text + appendage } : c,
  );
  return { ...base, content: merged };
}
