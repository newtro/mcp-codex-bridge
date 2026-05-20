import { runCodex, type RunCodexResult, type SandboxMode } from '../codex-runner.js';

export interface ImplementInput {
  spec: string;
  working_directory: string;
  files_in_scope?: string[];
  approval_mode?: SandboxMode;
  timeout_ms?: number;
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

export async function runImplement(input: ImplementInput): Promise<RunCodexResult> {
  if (!input.working_directory || input.working_directory.trim() === '') {
    throw new Error(
      "codex_implement requires 'working_directory' so Codex knows which checkout to modify. Pass the absolute path of the target repository.",
    );
  }
  const prompt = composeImplementPrompt(input);
  return runCodex({
    tool: 'codex_implement',
    prompt,
    cwd: input.working_directory,
    sandbox: input.approval_mode ?? 'workspace-write',
    skipGitCheck: false,
    timeoutMs: input.timeout_ms,
  });
}
