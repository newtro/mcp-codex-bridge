import { describe, expect, it } from 'vitest';
import { runImplement } from '../src/tools/implement.js';

describe('codex_implement input guards', () => {
  it('throws when working_directory is an empty string', async () => {
    await expect(
      runImplement({ spec: 'do thing', working_directory: '' }),
    ).rejects.toThrow(/working_directory/);
  });

  it('throws when working_directory is whitespace only', async () => {
    await expect(
      runImplement({ spec: 'do thing', working_directory: '   ' }),
    ).rejects.toThrow(/working_directory/);
  });

  it('throw message names the input field and explains the requirement', async () => {
    try {
      await runImplement({ spec: 'do thing', working_directory: '' });
      throw new Error('expected runImplement to reject');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toMatch(/working_directory/);
      expect(message).toMatch(/(absolute path|target repository|checkout)/i);
    }
  });
});
