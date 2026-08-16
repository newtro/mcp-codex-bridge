import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { grokProvider } from '../src/providers/grok.js';
import { codexProvider } from '../src/providers/codex.js';
import { composeReviewPrompt, REVIEW_FINDINGS_SCHEMA } from '../src/tools/review.js';

describe('grok buildArgs', () => {
  it('always requests the single-object json output format', () => {
    const args = grokProvider.buildArgs({});
    expect(args.slice(0, 2)).toEqual(['--output-format', 'json']);
  });

  it('strips write tools for read-only runs rather than trusting --sandbox', () => {
    // Grok's --sandbox is Landlock/Seatbelt only, so it is a no-op on Windows.
    // The tool allowlist is what actually makes a review run read-only there.
    const args = grokProvider.buildArgs({ sandbox: 'read-only' });
    expect(args).toContain('--sandbox');
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(args).toContain('--tools');
    const tools = args[args.indexOf('--tools') + 1] ?? '';
    expect(tools).toBe('read_file,grep,list_dir');
    expect(tools).not.toMatch(/search_replace|run_terminal_cmd/);
  });

  it('also denies the MCP tool pair, which the allowlist alone leaves in place', () => {
    // Observed against Grok Build 1.0.4: --tools did not strip search_tool /
    // use_tool, so a configured MCP server would remain a write path during a
    // review. The denylist is applied after the allowlist to close that.
    const args = grokProvider.buildArgs({ sandbox: 'read-only' });
    expect(args).toContain('--disallowed-tools');
    const denied = args[args.indexOf('--disallowed-tools') + 1] ?? '';
    for (const t of ['search_replace', 'run_terminal_cmd', 'search_tool', 'use_tool']) {
      expect(denied).toContain(t);
    }
  });

  it('does not apply the read-only denylist to write-capable modes', () => {
    const args = grokProvider.buildArgs({ sandbox: 'workspace-write' });
    expect(args).not.toContain('--disallowed-tools');
  });

  it('auto-approves write runs so a headless call cannot block on a prompt', () => {
    const args = grokProvider.buildArgs({ sandbox: 'workspace-write' });
    expect(args).toContain('--always-approve');
    expect(args[args.indexOf('--sandbox') + 1]).toBe('workspace');
  });

  it('maps danger-full-access to a disabled sandbox', () => {
    const args = grokProvider.buildArgs({ sandbox: 'danger-full-access' });
    expect(args[args.indexOf('--sandbox') + 1]).toBe('off');
    expect(args).toContain('--always-approve');
  });

  it('passes cwd, model, effort, max turns and schema through', () => {
    const args = grokProvider.buildArgs({
      cwd: '/repo',
      model: 'grok-4.6',
      reasoningEffort: 'high',
      maxTurns: 3,
      jsonSchema: '{"type":"object"}',
    });
    expect(args[args.indexOf('--cwd') + 1]).toBe('/repo');
    expect(args[args.indexOf('--model') + 1]).toBe('grok-4.6');
    expect(args[args.indexOf('--reasoning-effort') + 1]).toBe('high');
    expect(args[args.indexOf('--max-turns') + 1]).toBe('3');
    expect(args[args.indexOf('--json-schema') + 1]).toBe('{"type":"object"}');
  });

  it('ignores codex-only options that have no grok equivalent', () => {
    const args = grokProvider.buildArgs({ skipGitCheck: true, addDirs: ['/a', '/b'] });
    expect(args).not.toContain('--skip-git-repo-check');
    expect(args).not.toContain('--add-dir');
  });
});

describe('grok preparePrompt', () => {
  it('writes the prompt to a temp file instead of argv, then cleans it up', async () => {
    // A PR diff routinely exceeds the ~32 KB Windows argv limit, so the prompt
    // must never travel as a command-line argument.
    const big = 'x'.repeat(100_000);
    const transport = await grokProvider.preparePrompt(big);
    expect(transport.stdin).toBeNull();
    expect(transport.args[0]).toBe('--prompt-file');
    const file = transport.args[1] as string;
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(big);
    await transport.cleanup();
    expect(existsSync(file)).toBe(false);
  });

  it('cleanup is safe to call twice', async () => {
    const transport = await grokProvider.preparePrompt('hi');
    await transport.cleanup();
    await expect(transport.cleanup()).resolves.toBeUndefined();
  });
});

describe('grok parser', () => {
  const sample = JSON.stringify({
    text: 'the answer',
    sessionId: 'sess-1',
    stopReason: 'end_turn',
  });

  it('parses the single JSON object emitted at the end of a run', () => {
    const p = grokProvider.createParser();
    p.push(sample);
    const out = p.end();
    expect(out.finalMessage).toBe('the answer');
    expect(out.threadId).toBe('sess-1');
    expect(out.parseFailures).toHaveLength(0);
  });

  it('reassembles an object split across chunk boundaries', () => {
    const p = grokProvider.createParser();
    const mid = Math.floor(sample.length / 2);
    p.push(sample.slice(0, mid));
    p.push(sample.slice(mid));
    expect(p.end().finalMessage).toBe('the answer');
  });

  it('tolerates a non-JSON preamble such as an update or sandbox notice', () => {
    const p = grokProvider.createParser();
    p.push('warning: sandbox profile could not be applied on this platform\n');
    p.push(sample);
    expect(p.end().finalMessage).toBe('the answer');
  });

  it('surfaces structuredOutput when a schema constrained the run', () => {
    const p = grokProvider.createParser();
    p.push(
      JSON.stringify({
        text: '{"findings":[]}',
        structuredOutput: { findings: [], verdict: 'CLEAN' },
      }),
    );
    const out = p.end();
    expect(out.structured).toEqual({ findings: [], verdict: 'CLEAN' });
  });

  it('reports a parse failure rather than a silent empty success on garbage', () => {
    const p = grokProvider.createParser();
    p.push('not json at all');
    const out = p.end();
    expect(out.finalMessage).toBe('');
    expect(out.parseFailures).toHaveLength(1);
  });
});

describe('grok interpretAuthProbe', () => {
  it('reads logged-in state and the default model from `grok models`', () => {
    const stdout = 'You are logged in with grok.com.\n\nDefault model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n';
    const res = grokProvider.interpretAuthProbe(stdout, '', 0);
    expect(res.loggedIn).toBe(true);
    expect(res.defaultModel).toBe('grok-4.6');
  });

  it('treats a sign-in prompt as logged out', () => {
    const res = grokProvider.interpretAuthProbe('', 'Sign in to Grok to continue', 1);
    expect(res.loggedIn).toBe(false);
  });

  it('does not report logged in on a non-zero exit', () => {
    const res = grokProvider.interpretAuthProbe('You are logged in with grok.com.', '', 1);
    expect(res.loggedIn).toBe(false);
  });
});

describe('provider capability flags', () => {
  it('marks grok as schema and effort capable, codex as neither', () => {
    expect(grokProvider.supportsJsonSchema).toBe(true);
    expect(grokProvider.supportsReasoningEffort).toBe(true);
    expect(codexProvider.supportsJsonSchema).toBe(false);
    expect(codexProvider.supportsReasoningEffort).toBe(false);
  });

  it('gives each provider its own error prefix and binary override', () => {
    expect(grokProvider.errorPrefix).toBe('GROK');
    expect(codexProvider.errorPrefix).toBe('CODEX');
    expect(grokProvider.binaryEnvVar).toBe('GROK_CLI_PATH');
    expect(codexProvider.binaryEnvVar).toBe('CODEX_CLI_PATH');
  });
});

describe('structured review prompt', () => {
  it('keeps the markdown contract when structured output is not requested', () => {
    const out = composeReviewPrompt({ diff: '+x' });
    expect(out).toMatch(/BLOCKER/);
    expect(out).not.toMatch(/JSON Schema/);
  });

  it('replaces the markdown sections with the schema when structured', () => {
    const out = composeReviewPrompt({ diff: '+x', structured: true });
    expect(out).toMatch(/JSON Schema/);
    expect(out).not.toMatch(/### BLOCKER/);
    expect(out).toContain('suggested_fix');
  });

  it('states the schema in the prompt even for providers with a native flag', () => {
    // Codex cannot constrain decoding, so the prompt is the only carrier of
    // the contract. Both providers therefore get it in the text as well.
    const out = composeReviewPrompt({ diff: '+x', structured: true });
    expect(out).toContain(JSON.stringify(REVIEW_FINDINGS_SCHEMA));
  });

  it('honours a caller-supplied schema over the built-in one', () => {
    const custom = '{"type":"object","properties":{"only_this":{"type":"string"}}}';
    const out = composeReviewPrompt({ diff: '+x', output_schema: custom });
    expect(out).toContain('only_this');
    expect(out).not.toContain('suggested_fix');
  });
});
