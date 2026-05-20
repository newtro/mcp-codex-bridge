import type { CodexErrorClass } from './errors.js';

export interface LogEntry {
  ts: string;
  tool: string;
  durationMs: number;
  exitCode: number | null;
  errorClass: CodexErrorClass | 'OK';
  argSummary: Record<string, unknown>;
}

/**
 * stdio MCP transport reserves stdout for protocol traffic. Logs go to
 * stderr as one JSON object per line so the MCP host (Claude Code) and
 * downstream aggregators can parse them without a custom format.
 */
export function logInvocation(entry: LogEntry): void {
  process.stderr.write(JSON.stringify(entry) + '\n');
}

export function nowIso(): string {
  return new Date().toISOString();
}
