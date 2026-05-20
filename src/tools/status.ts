import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probeAuth, probeVersion } from '../codex-runner.js';

export interface StatusResult {
  installed: boolean;
  version: string | null;
  authStatus: 'logged_in' | 'logged_out' | 'unknown';
  authDetail: string;
  binaryPath: string;
  defaultModel: string | null;
  defaultTimeoutMs: number;
  warnings: string[];
}

/**
 * Codex stores its default model in ~/.codex/config.toml as `model = "..."`.
 * A full TOML parser is overkill for a single key, and pinning a real parser
 * would add a transitive dependency just to read one line. The narrow regex
 * tolerates surrounding whitespace, quote style, and comments.
 *
 * CODEX_HOME is resolved on each call so tests and runtime overrides take
 * effect after module load.
 */
async function readDefaultModel(): Promise<string | null> {
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const configPath = path.join(codexHome, 'config.toml');
  let content: string;
  try {
    content = await fs.readFile(configPath, 'utf8');
  } catch {
    return null;
  }
  // Match top-level `model = "..."` only. A bracketed section (e.g. [profile.foo])
  // appearing before the key would put it inside that section; this regex
  // intentionally accepts only the first top-level occurrence.
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) break;
    const match = /^model\s*=\s*["']([^"']+)["']/.exec(trimmed);
    if (match && match[1]) return match[1];
  }
  return null;
}

export async function getStatus(): Promise<StatusResult> {
  const binaryPath = process.env.CODEX_CLI_PATH ?? 'codex';
  const envTimeout = process.env.CODEX_MCP_TIMEOUT_MS
    ? Number.parseInt(process.env.CODEX_MCP_TIMEOUT_MS, 10)
    : NaN;
  const defaultTimeoutMs = Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 5 * 60 * 1000;

  const warnings: string[] = [];
  const version = await probeVersion();
  // Skip the auth probe entirely when the binary did not respond. The probe
  // would just hit the same spawn error and wait out its own timeout.
  const auth = version === null ? { loggedIn: false, raw: '' } : await probeAuth();
  const defaultModel = await readDefaultModel();

  if (version === null) {
    warnings.push(
      `Codex CLI did not respond to '${binaryPath} --version'. Install Codex CLI from https://github.com/openai/codex or set CODEX_CLI_PATH to its absolute path.`,
    );
  } else if (!auth.loggedIn) {
    // Suggesting `codex login` is only useful once the CLI is present.
    warnings.push("Run 'codex login' to sign in with your ChatGPT account, then retry.");
  }

  // authStatus stays 'unknown' when the version probe fails because no
  // auth signal could be obtained from a missing binary.
  return {
    installed: version !== null,
    version,
    authStatus: version === null ? 'unknown' : auth.loggedIn ? 'logged_in' : 'logged_out',
    authDetail: auth.raw,
    binaryPath,
    defaultModel,
    defaultTimeoutMs,
    warnings,
  };
}

export function formatStatus(s: StatusResult): string {
  const lines: string[] = [];
  lines.push(`Codex CLI: ${s.installed ? `installed (${s.version})` : 'NOT FOUND'}`);
  lines.push(`Binary path: ${s.binaryPath}`);
  lines.push(`Auth: ${s.authStatus}`);
  if (s.authDetail) lines.push(`Auth detail: ${s.authDetail}`);
  lines.push(`Default model: ${s.defaultModel ?? '(not set in config.toml; Codex CLI default applies)'}`);
  lines.push(`Default timeout: ${s.defaultTimeoutMs} ms`);
  if (s.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const w of s.warnings) lines.push(`  - ${w}`);
  }
  return lines.join('\n');
}
