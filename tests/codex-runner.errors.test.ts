import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetSpawnForTests,
  _setSpawnForTests,
  runCodex,
} from '../src/codex-runner.js';
import { programmableSpawn } from './helpers/fake-spawn.js';

// One fake per test for clean state. The injection setter swaps the spawn
// function used by codex-runner without touching the import graph, so no
// vi.mock hoisting gymnastics are required.
let fake: ReturnType<typeof programmableSpawn>;

beforeEach(() => {
  fake = programmableSpawn();
  _setSpawnForTests(fake.spawnFn as never);
});

afterEach(() => {
  _resetSpawnForTests();
});

function jsonlSuccess(text = 'final answer'): string {
  return (
    JSON.stringify({ type: 'thread.started', thread_id: 'tid-1' }) +
    '\n' +
    JSON.stringify({ type: 'turn.started' }) +
    '\n' +
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text },
    }) +
    '\n' +
    JSON.stringify({ type: 'turn.completed' }) +
    '\n'
  );
}

describe('runCodex error mapping', () => {
  it('maps spawn ENOENT to CODEX_NOT_FOUND with actionable userAction', async () => {
    const err: NodeJS.ErrnoException = new Error("spawn 'codex' ENOENT");
    err.code = 'ENOENT';
    fake.throwOnNextSpawn(err);
    const result = await runCodex({ prompt: 'hi', tool: 'codex_ask' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorClass).toBe('CODEX_NOT_FOUND');
    expect(result.userAction).toMatch(/Install Codex/i);
  });

  it('maps spawn EACCES to CODEX_NOT_FOUND too', async () => {
    const err: NodeJS.ErrnoException = new Error('permission denied');
    err.code = 'EACCES';
    fake.throwOnNextSpawn(err);
    const result = await runCodex({ prompt: 'hi', tool: 'codex_ask' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorClass).toBe('CODEX_NOT_FOUND');
  });

  it('maps async spawn error to CODEX_FAILED for unknown errno', async () => {
    fake.next((child) => {
      const err: NodeJS.ErrnoException = new Error('weird');
      err.code = 'EUNKNOWN';
      child.emit('error', err);
    });
    const result = await runCodex({ prompt: 'hi', tool: 'codex_ask' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorClass).toBe('CODEX_FAILED');
  });

  it('detects auth failure pattern in stderr', async () => {
    fake.next((child) => {
      child.stderr.write('Error: Not logged in. Please run `codex login` to authenticate.\n');
      child.stderr.end();
      child.stdout.end();
      setImmediate(() => child.emit('close', 1, null));
    });
    const result = await runCodex({ prompt: 'hi', tool: 'codex_ask' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorClass).toBe('CODEX_NOT_AUTHENTICATED');
    expect(result.userAction).toMatch(/codex login/);
  });

  it('detects rate-limit pattern in stderr', async () => {
    fake.next((child) => {
      child.stderr.write('Error: 429 Too Many Requests. Usage limit reached.\n');
      child.stderr.end();
      child.stdout.end();
      setImmediate(() => child.emit('close', 1, null));
    });
    const result = await runCodex({ prompt: 'hi', tool: 'codex_ask' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorClass).toBe('CODEX_RATE_LIMITED');
  });

  it('detects rate-limit pattern surfaced inside an event (not just stderr)', async () => {
    fake.next((child) => {
      child.stdout.write(
        JSON.stringify({
          type: 'turn.failed',
          error: 'rate limit exceeded for this account',
        }) + '\n',
      );
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', 1, null));
    });
    const result = await runCodex({ prompt: 'hi', tool: 'codex_ask' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorClass).toBe('CODEX_RATE_LIMITED');
  });

  it('falls back to CODEX_FAILED for unrecognised non-zero exit', async () => {
    fake.next((child) => {
      child.stderr.write('Random error message\n');
      child.stderr.end();
      child.stdout.end();
      setImmediate(() => child.emit('close', 2, null));
    });
    const result = await runCodex({ prompt: 'hi', tool: 'codex_ask' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorClass).toBe('CODEX_FAILED');
    expect(result.exitCode).toBe(2);
  });

  it('returns CODEX_PARSE_ERROR when exit is 0 but no agent_message arrived', async () => {
    fake.next((child) => {
      child.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'x' }) + '\n');
      child.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\n');
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', 0, null));
    });
    const result = await runCodex({ prompt: 'hi', tool: 'codex_ask' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorClass).toBe('CODEX_PARSE_ERROR');
  });

  it('returns CODEX_PARSE_ERROR when stdout is unparseable garbage on exit 0', async () => {
    fake.next((child) => {
      child.stdout.write('this is not json at all\n');
      child.stdout.write('still not json\n');
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', 0, null));
    });
    const result = await runCodex({ prompt: 'hi', tool: 'codex_ask' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorClass).toBe('CODEX_PARSE_ERROR');
    expect(result.message).toMatch(/unparseable/i);
  });

  it('returns ok:true with the final agent_message on success', async () => {
    fake.next((child) => {
      child.stdout.write(jsonlSuccess('Hello back'));
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', 0, null));
    });
    const result = await runCodex({ prompt: 'hi', tool: 'codex_ask' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.finalMessage).toBe('Hello back');
    expect(result.threadId).toBe('tid-1');
    expect(result.exitCode).toBe(0);
  });

  it('forwards prompt to subprocess stdin', async () => {
    let observed = '';
    fake.next((child, getStdin) => {
      setImmediate(() => {
        observed = getStdin();
        child.stdout.write(jsonlSuccess('ok'));
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 0, null);
      });
    });
    const result = await runCodex({ prompt: 'unique-marker-1234', tool: 'codex_ask' });
    expect(result.ok).toBe(true);
    expect(observed).toContain('unique-marker-1234');
  });

  it('hits CODEX_TIMEOUT when subprocess does not finish in time', async () => {
    fake.next(() => {
      // Never close. The timer in runCodex must trigger the kill path.
    });
    const result = await runCodex({ prompt: 'hi', tool: 'codex_ask', timeoutMs: 50 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorClass).toBe('CODEX_TIMEOUT');
    expect(result.userAction).toMatch(/timeout/i);
  }, 5000);
});
