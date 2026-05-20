import { runCodex, type RunCodexResult } from '../codex-runner.js';

export interface ReviewInput {
  diff: string;
  focus_areas?: string[];
  context?: string;
  working_directory?: string;
  timeout_ms?: number;
}

export function composeReviewPrompt(input: ReviewInput): string {
  const parts: string[] = [];
  parts.push(
    'You are an adversarial code reviewer. Your job is to find every reason this change is wrong, risky, or incomplete. Be specific. Cite file:line for every finding.',
  );
  parts.push('');
  if (input.context) {
    parts.push('## What this change is trying to do');
    parts.push(input.context);
    parts.push('');
  }
  if (input.focus_areas && input.focus_areas.length > 0) {
    parts.push('## Focus areas (weight these heavily)');
    for (const area of input.focus_areas) parts.push(`- ${area}`);
    parts.push('');
  }
  parts.push('## Diff or code under review');
  parts.push('```diff');
  parts.push(input.diff);
  parts.push('```');
  parts.push('');
  parts.push('## Required output format');
  parts.push('Respond as Markdown with this exact structure:');
  parts.push('');
  parts.push('### BLOCKER');
  parts.push('- file:line - issue - suggested fix');
  parts.push('### MAJOR');
  parts.push('- file:line - issue - suggested fix');
  parts.push('### MINOR');
  parts.push('- file:line - issue - suggested fix');
  parts.push('### What I checked but found clean');
  parts.push('- short bullets');
  parts.push('### Verdict');
  parts.push('CLEAN or ISSUES_FOUND (with counts)');
  return parts.join('\n');
}

export async function runReview(input: ReviewInput): Promise<RunCodexResult> {
  const prompt = composeReviewPrompt(input);
  return runCodex({
    tool: 'codex_review',
    prompt,
    cwd: input.working_directory,
    sandbox: 'read-only',
    skipGitCheck: true,
    timeoutMs: input.timeout_ms,
  });
}
