import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The TOML reader inside getStatus reads from $CODEX_HOME/config.toml. Tests
 * here point CODEX_HOME at a throwaway tmp directory per case so production
 * state is not consulted.
 */
describe('readDefaultModel via getStatus', () => {
  let originalCodexHome: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    originalCodexHome = process.env.CODEX_HOME;
    tempDir = mkdtempSync(path.join(tmpdir(), 'codex-test-'));
    process.env.CODEX_HOME = tempDir;
  });

  afterEach(() => {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
  });

  it('returns the top-level model value when present', async () => {
    writeFileSync(
      path.join(tempDir, 'config.toml'),
      'model = "gpt-5.5"\nmodel_reasoning_effort = "high"\n',
    );
    // Dynamic import per test so CODEX_HOME is picked up fresh by the module.
    const { getStatus } = await import('../src/tools/status.js?t=' + Date.now());
    const status = await getStatus();
    expect(status.defaultModel).toBe('gpt-5.5');
  });

  it('stops at the first bracketed section header', async () => {
    writeFileSync(
      path.join(tempDir, 'config.toml'),
      [
        '# comment line',
        'model = "real-model"',
        '',
        '[profile.foo]',
        'model = "wrong-model"',
      ].join('\n'),
    );
    const { getStatus } = await import('../src/tools/status.js?t=' + Date.now());
    const status = await getStatus();
    expect(status.defaultModel).toBe('real-model');
  });

  it('returns null when the file is missing', async () => {
    // No config.toml written.
    const { getStatus } = await import('../src/tools/status.js?t=' + Date.now());
    const status = await getStatus();
    expect(status.defaultModel).toBeNull();
  });

  it('returns null when no top-level model key exists', async () => {
    writeFileSync(
      path.join(tempDir, 'config.toml'),
      '[profile.foo]\nmodel = "buried"\n',
    );
    const { getStatus } = await import('../src/tools/status.js?t=' + Date.now());
    const status = await getStatus();
    expect(status.defaultModel).toBeNull();
  });

  it('accepts single-quoted values', async () => {
    writeFileSync(path.join(tempDir, 'config.toml'), "model = 'gpt-4.1'\n");
    const { getStatus } = await import('../src/tools/status.js?t=' + Date.now());
    const status = await getStatus();
    expect(status.defaultModel).toBe('gpt-4.1');
  });
});
