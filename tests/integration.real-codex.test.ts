import { describe, expect, it } from 'vitest';
import { probeAuth, probeVersion, runCodex } from '../src/codex-runner.js';

/**
 * Real integration test against an installed Codex CLI. Skipped unless the
 * RUN_INTEGRATION env var is truthy so CI does not depend on auth/state.
 * Run locally with:  npm run test:integration
 */
const ENABLED = process.env.RUN_INTEGRATION === '1';
const describeIntegration = ENABLED ? describe : describe.skip;

describeIntegration('Codex CLI integration (RUN_INTEGRATION=1)', () => {
  it('reports an installed version', async () => {
    const version = await probeVersion();
    expect(version).not.toBeNull();
    expect(version!.toLowerCase()).toContain('codex');
  });

  it('reports a logged-in auth state (requires `codex login`)', async () => {
    const auth = await probeAuth();
    expect(auth.loggedIn).toBe(true);
  });

  it(
    'completes a trivial read-only turn end-to-end',
    async () => {
      const result = await runCodex({
        tool: 'integration_test',
        prompt: 'Reply with the single word PONG and nothing else.',
        sandbox: 'read-only',
        skipGitCheck: true,
        timeoutMs: 120_000,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.finalMessage.toUpperCase()).toContain('PONG');
    },
    150_000,
  );
});
