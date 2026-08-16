import type { CliErrorClass } from './errors.js';
import type { ProviderId } from './providers/types.js';

export interface LogEntry {
  ts: string;
  /** Which CLI backend handled the call. Absent on server-level events. */
  provider?: ProviderId;
  tool: string;
  durationMs: number;
  exitCode: number | null;
  errorClass: CliErrorClass | 'OK';
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
