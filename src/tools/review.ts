import { runCli, type RunCliResult } from '../cli-runner.js';
import { getProvider } from '../providers/index.js';
import type { ProviderId } from '../providers/types.js';

export interface ReviewInput {
  diff: string;
  focus_areas?: string[];
  context?: string;
  working_directory?: string;
  timeout_ms?: number;
  model?: string;
  reasoning_effort?: string;
  /** Ask for machine-readable findings instead of the markdown report. */
  structured?: boolean;
  /** Custom JSON Schema. Implies structured. Overrides REVIEW_FINDINGS_SCHEMA. */
  output_schema?: string;
}

/**
 * Canonical findings contract.
 *
 * The point of this schema is cross-reviewer comparability. When several CLIs
 * review the same diff, reconciliation is only mechanical if every reviewer
 * returns the same shape; otherwise the caller has to parse three different
 * report formats and infer equivalence, which is exactly the interpretive step
 * that lets disagreements get papered over.
 *
 * `category` is deliberately a free string rather than an enum: the taxonomy
 * belongs to the calling project, not to this bridge.
 */
export const REVIEW_FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings', 'verdict'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'line', 'severity', 'category', 'evidence', 'issue', 'suggested_fix', 'confidence'],
        properties: {
          file: { type: 'string', description: 'Repo-relative path.' },
          line: { type: 'integer', description: 'Line number in the post-change file.' },
          severity: { type: 'string', enum: ['CRITICAL', 'WARNING', 'INFO'] },
          category: { type: 'string', description: 'Caller-defined finding category.' },
          evidence: { type: 'string', description: 'Short verbatim quote from the changed code.' },
          issue: { type: 'string', description: 'One sentence: what is wrong.' },
          suggested_fix: { type: 'string', description: 'One sentence: how to fix it.' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
    checked_clean: {
      type: 'array',
      items: { type: 'string' },
      description: 'Areas examined and found clean.',
    },
    verdict: { type: 'string', enum: ['CLEAN', 'ISSUES_FOUND'] },
  },
} as const;

function resolveSchema(input: ReviewInput): string | undefined {
  if (input.output_schema) return input.output_schema;
  if (input.structured) return JSON.stringify(REVIEW_FINDINGS_SCHEMA);
  return undefined;
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

  const schema = resolveSchema(input);
  if (schema) {
    // Stated in the prompt as well as passed via --json-schema, because not
    // every provider can constrain decoding. For those, the prompt is the
    // only thing holding the contract.
    parts.push('## Required output format');
    parts.push('Respond with JSON only. No prose, no code fence. Match this JSON Schema exactly:');
    parts.push('```json');
    parts.push(schema);
    parts.push('```');
    parts.push('Return an empty findings array if the change is clean.');
    return parts.join('\n');
  }

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

export async function runReview(
  input: ReviewInput,
  providerId: ProviderId = 'codex',
): Promise<RunCliResult> {
  const provider = getProvider(providerId);
  return runCli(provider, {
    tool: `${providerId}_review`,
    prompt: composeReviewPrompt(input),
    cwd: input.working_directory,
    sandbox: 'read-only',
    skipGitCheck: true,
    model: input.model,
    reasoningEffort: input.reasoning_effort,
    jsonSchema: resolveSchema(input),
    timeoutMs: input.timeout_ms,
  });
}
