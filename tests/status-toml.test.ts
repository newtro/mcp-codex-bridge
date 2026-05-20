import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetSpawnForTests,
  _setSpawnForTests,
} from '../src/codex-runner.js';
import { programmableSpawn } from './helpers/fake-spawn.js';

/**
 * The TOML reader inside getStatus reads from $CODEX_HOME/config.toml. Tests
 * here point CODEX_HOME at a throwaway tmp directory per case so production
 * state is not consulted. The fake spawn is also installed so probeVersion
 * and probeAuth return synthetic results instead of touching the real PATH.
 */
describe('readDefaultModel via getStatus', () => {
  let originalCodexHome: string | undefined;
  let tempDir: string;
  let fake: ReturnType<typeof programmableSpawn>;

  beforeEach(() => {
    originalCodexHome = process.env.CODEX_HOME;
    tempDir = mkdtempSync(path.join(tmpdir(), 'codex-test-'));
    process.env.CODEX_HOME = tempDir;
    fake = programmableSpawn();
    _setSpawnForTests(fake.spawnFn as never);
    // Each getStatus call kicks off probeVersion then (conditionally) probeAuth.
    // Drive both probes through fast-failing fake outcomes so the tests focus
    // on the TOML reader path under test.
    for (let i = 0; i < 2; i++) {
      fake.next((child) => {
        child.stdout.end();
        child.stderr.end();
        setImmediate(() => child.emit('close', 1, null));
      });
    }
  });

  afterEach(() => {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    rmSync(tempDir, { recursive: true, force: true });
    _resetSpawnForTests();
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
