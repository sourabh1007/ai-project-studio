import { afterEach, describe, expect, it, vi } from 'vitest';

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: execute }),
}));

import { createReviewContextCommandRunner } from './review-context-process-adapter.js';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  execute.mockReset();
});

describe('review context process boundary', () => {
  it.each(['win32', 'linux'])('uses bounded shell-free isolated Git execution on %s', async (value) => {
    Object.defineProperty(process, 'platform', { ...platform, value });
    const output = { stdout: Buffer.from('blob'), stderr: Buffer.alloc(0) };
    execute.mockResolvedValue(output);
    const controller = new AbortController();
    const options = { cwd: 'C:\\repo', maxBuffer: 200, timeout: 500, signal: controller.signal };
    expect(await createReviewContextCommandRunner().run('git', ['cat-file', 'blob', 'a'.repeat(40)], options)).toBe(output);
    expect(execute).toHaveBeenCalledWith('git', ['cat-file', 'blob', 'a'.repeat(40)], {
      ...options, encoding: 'buffer', windowsHide: true, shell: false,
      env: expect.objectContaining({
        GIT_CONFIG_GLOBAL: value === 'win32' ? 'NUL' : '/dev/null',
        GIT_CONFIG_SYSTEM: value === 'win32' ? 'NUL' : '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
        GIT_NO_REPLACE_OBJECTS: '1', GIT_CONFIG_COUNT: '0',
      }),
    });
  });

  it('propagates process failures rather than returning worktree content', async () => {
    execute.mockRejectedValue(new Error('timeout'));
    await expect(createReviewContextCommandRunner().run('git', [], { cwd: 'repo', maxBuffer: 1, timeout: 1 }))
      .rejects.toThrow('timeout');
  });
});
