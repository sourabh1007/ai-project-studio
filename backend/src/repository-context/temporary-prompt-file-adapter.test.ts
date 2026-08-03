import { access, readFile } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTemporaryPromptFileFactory } from './temporary-prompt-file-adapter.js';

describe('temporary-prompt-file-adapter', () => {
  it('writes a valid text PDF outside the checkout and removes its directory', async () => {
    const content = 'repository evidence: café';
    const temporary = await createTemporaryPromptFileFactory().create(
      content,
      process.cwd(),
    );

    const pdf = await readFile(temporary.path);
    expect(temporary.path.endsWith('p.pdf')).toBe(true);
    expect(pdf.subarray(0, 8).toString('ascii')).toBe('%PDF-1.4');
    expect(pdf.toString('latin1')).toContain('(repository evidence: caf\\351) Tj');
    // The prompt file must live outside the checkout. `path.relative` yields a
    // `..`-prefixed path normally, but on Windows a temp dir on a different
    // drive than the checkout is returned as an absolute path (no `..`); both
    // mean "outside", so accept either.
    const location = relative(process.cwd(), temporary.path);
    expect(location.startsWith('..') || isAbsolute(location)).toBe(true);

    await temporary.cleanup();
    await expect(access(temporary.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
