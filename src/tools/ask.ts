import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runCodex, type RunCodexResult } from '../codex-runner.js';

export interface AskInput {
  prompt: string;
  working_directory?: string;
  context_files?: string[];
  timeout_ms?: number;
}

const MAX_CONTEXT_BYTES_PER_FILE = 64 * 1024;

async function readContextFile(filePath: string, cwd: string): Promise<string> {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) {
    throw new Error(`Context path is not a regular file: ${resolved}`);
  }
  const buf = await fs.readFile(resolved);
  const truncated = buf.length > MAX_CONTEXT_BYTES_PER_FILE;
  const slice = truncated ? buf.subarray(0, MAX_CONTEXT_BYTES_PER_FILE).toString('utf8') : buf.toString('utf8');
  const header = `### file: ${path.relative(cwd, resolved)}${truncated ? ` (truncated to ${MAX_CONTEXT_BYTES_PER_FILE} bytes)` : ''}`;
  return `${header}\n\`\`\`\n${slice}\n\`\`\``;
}

export async function composeAskPrompt(input: AskInput): Promise<string> {
  const cwd = input.working_directory ?? process.cwd();
  const parts: string[] = [];
  if (input.context_files && input.context_files.length > 0) {
    parts.push('## Context files');
    for (const file of input.context_files) {
      try {
        parts.push(await readContextFile(file, cwd));
      } catch (err) {
        parts.push(`### file: ${file}\n[could not read: ${(err as Error).message}]`);
      }
    }
    parts.push('');
  }
  parts.push('## Question');
  parts.push(input.prompt);
  return parts.join('\n');
}

export async function runAsk(input: AskInput): Promise<RunCodexResult> {
  const composed = await composeAskPrompt(input);
  return runCodex({
    tool: 'codex_ask',
    prompt: composed,
    cwd: input.working_directory,
    sandbox: 'read-only',
    skipGitCheck: true,
    timeoutMs: input.timeout_ms,
  });
}
