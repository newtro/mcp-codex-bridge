import { describe, expect, it } from 'vitest';
import { composeAskPrompt } from '../src/tools/ask.js';
import { composeReviewPrompt } from '../src/tools/review.js';
import { composeImplementPrompt } from '../src/tools/implement.js';

describe('composeAskPrompt', () => {
  it('produces a prompt containing the user question', async () => {
    const out = await composeAskPrompt({ prompt: 'What does X mean?' });
    expect(out).toContain('## Question');
    expect(out).toContain('What does X mean?');
  });

  it('omits the context section when no context_files are given', async () => {
    const out = await composeAskPrompt({ prompt: 'Q' });
    expect(out).not.toContain('## Context files');
  });

  it('includes a context section when files are given (even if unreadable)', async () => {
    const out = await composeAskPrompt({
      prompt: 'Q',
      context_files: ['/definitely/does/not/exist.txt'],
    });
    expect(out).toContain('## Context files');
    expect(out).toContain('could not read');
  });
});

describe('composeReviewPrompt', () => {
  it('embeds the diff inside a diff code fence', () => {
    const out = composeReviewPrompt({ diff: 'diff --git a/foo b/foo\n+hello' });
    expect(out).toContain('```diff');
    expect(out).toContain('diff --git a/foo b/foo');
  });

  it('asks for the structured output format', () => {
    const out = composeReviewPrompt({ diff: '+x' });
    expect(out).toMatch(/BLOCKER/);
    expect(out).toMatch(/MAJOR/);
    expect(out).toMatch(/MINOR/);
    expect(out).toMatch(/Verdict/);
  });

  it('includes focus_areas when provided', () => {
    const out = composeReviewPrompt({ diff: '+x', focus_areas: ['security', 'race conditions'] });
    expect(out).toMatch(/security/);
    expect(out).toMatch(/race conditions/);
  });

  it('omits the focus_areas section when none are provided', () => {
    const out = composeReviewPrompt({ diff: '+x' });
    expect(out).not.toContain('## Focus areas');
  });

  it('includes context when provided', () => {
    const out = composeReviewPrompt({ diff: '+x', context: 'porting from python to go' });
    expect(out).toContain('porting from python to go');
  });
});

describe('composeImplementPrompt', () => {
  it('includes the spec body', () => {
    const out = composeImplementPrompt({
      spec: 'Add a /health endpoint that returns {ok:true}',
      working_directory: '/tmp/x',
    });
    expect(out).toContain('Add a /health endpoint');
  });

  it('lists files_in_scope when given', () => {
    const out = composeImplementPrompt({
      spec: 'do thing',
      working_directory: '/tmp/x',
      files_in_scope: ['src/server.ts', 'src/handlers/health.ts'],
    });
    expect(out).toContain('## Files in scope');
    expect(out).toContain('src/server.ts');
    expect(out).toContain('src/handlers/health.ts');
  });

  it('omits the files-in-scope section when none are given', () => {
    const out = composeImplementPrompt({ spec: 'do thing', working_directory: '/tmp/x' });
    expect(out).not.toContain('## Files in scope');
  });

  it('asks for a summary of changes at the end', () => {
    const out = composeImplementPrompt({ spec: 'do thing', working_directory: '/tmp/x' });
    expect(out).toMatch(/## When you finish/);
    expect(out).toMatch(/summari[sz]e/i);
  });
});
