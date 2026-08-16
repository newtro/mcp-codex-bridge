import { probeAuthFor, probeVersionFor } from '../cli-runner.js';
import { getProvider } from '../providers/index.js';
import type { ProviderId } from '../providers/types.js';

export interface StatusResult {
  provider: ProviderId;
  displayName: string;
  installed: boolean;
  version: string | null;
  authStatus: 'logged_in' | 'logged_out' | 'unknown';
  authDetail: string;
  binaryPath: string;
  defaultModel: string | null;
  defaultTimeoutMs: number;
  warnings: string[];
}

export async function getStatus(providerId: ProviderId = 'codex'): Promise<StatusResult> {
  const provider = getProvider(providerId);
  const binaryPath = process.env[provider.binaryEnvVar] ?? provider.defaultBinary;
  const envTimeout = process.env[provider.timeoutEnvVar]
    ? Number.parseInt(process.env[provider.timeoutEnvVar] as string, 10)
    : NaN;
  const defaultTimeoutMs =
    Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 5 * 60 * 1000;

  const warnings: string[] = [];
  const version = await probeVersionFor(provider);
  // Skip the auth probe entirely when the binary did not respond. The probe
  // would just hit the same spawn error and wait out its own timeout.
  const auth =
    version === null
      ? { loggedIn: false, raw: '', defaultModel: null }
      : await probeAuthFor(provider);
  // Prefer what the live probe reported; fall back to the CLI's config file.
  const defaultModel = auth.defaultModel ?? (await provider.readDefaultModel());

  if (version === null) {
    warnings.push(`${provider.displayName} CLI did not respond to '${binaryPath} ${provider.versionArgs.join(' ')}'. ${provider.installHint}`);
  } else if (!auth.loggedIn) {
    // The login hint is only useful once the CLI is present.
    warnings.push(provider.loginHint);
  }

  // authStatus stays 'unknown' when the version probe fails, because no auth
  // signal could be obtained from a missing binary.
  return {
    provider: provider.id,
    displayName: provider.displayName,
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
  lines.push(`${s.displayName} CLI: ${s.installed ? `installed (${s.version})` : 'NOT FOUND'}`);
  lines.push(`Binary path: ${s.binaryPath}`);
  lines.push(`Auth: ${s.authStatus}`);
  if (s.authDetail) {
    // Some probes are chatty (Grok's `models` prints the whole catalogue).
    // Only the first meaningful line belongs in a status summary; the rest is
    // already represented by the fields below it.
    const firstLine = s.authDetail.split(/\r?\n/).find((l) => l.trim().length > 0);
    if (firstLine) lines.push(`Auth detail: ${firstLine.trim()}`);
  }
  lines.push(`Default model: ${s.defaultModel ?? '(not configured; CLI default applies)'}`);
  lines.push(`Default timeout: ${s.defaultTimeoutMs} ms`);
  if (s.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const w of s.warnings) lines.push(`  - ${w}`);
  }
  return lines.join('\n');
}
