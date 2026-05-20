import { describe, expect, it } from 'vitest';
import { buildCodexArgs } from '../src/codex-runner.js';

describe('buildCodexArgs', () => {
  it('always emits the exec subcommand and JSON mode', () => {
    const args = buildCodexArgs({ prompt: 'hi', tool: 'codex_ask' });
    expect(args[0]).toBe('exec');
    expect(args).toContain('--json');
    expect(args[args.length - 1]).toBe('-');
  });

  it('passes sandbox when provided', () => {
    const args = buildCodexArgs({ prompt: 'hi', tool: 'codex_ask', sandbox: 'read-only' });
    expect(args).toContain('--sandbox');
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
  });

  it('passes cwd via -C', () => {
    const args = buildCodexArgs({ prompt: 'hi', tool: 'codex_ask', cwd: '/tmp/work' });
    expect(args).toContain('-C');
    expect(args[args.indexOf('-C') + 1]).toBe('/tmp/work');
  });

  it('passes --skip-git-repo-check when enabled', () => {
    const args = buildCodexArgs({ prompt: 'hi', tool: 'codex_ask', skipGitCheck: true });
    expect(args).toContain('--skip-git-repo-check');
  });

  it('omits --skip-git-repo-check by default', () => {
    const args = buildCodexArgs({ prompt: 'hi', tool: 'codex_ask' });
    expect(args).not.toContain('--skip-git-repo-check');
  });

  it('passes model override', () => {
    const args = buildCodexArgs({ prompt: 'hi', tool: 'codex_ask', model: 'gpt-5' });
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('gpt-5');
  });

  it('passes each addDir as a separate --add-dir flag', () => {
    const args = buildCodexArgs({ prompt: 'hi', tool: 'codex_ask', addDirs: ['/a', '/b'] });
    const flagIndexes = args
      .map((a, i) => (a === '--add-dir' ? i : -1))
      .filter((i) => i !== -1);
    expect(flagIndexes).toHaveLength(2);
    expect(args[flagIndexes[0]! + 1]).toBe('/a');
    expect(args[flagIndexes[1]! + 1]).toBe('/b');
  });

  it('combines multiple options in the expected order', () => {
    const args = buildCodexArgs({
      prompt: 'hi',
      tool: 'codex_implement',
      sandbox: 'workspace-write',
      cwd: '/repo',
      skipGitCheck: false,
      model: 'gpt-5-codex',
    });
    expect(args).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '-C',
      '/repo',
      '--model',
      'gpt-5-codex',
      '-',
    ]);
  });
});
