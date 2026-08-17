import { describe, expect, it } from 'vitest';
import {
  createGithubDescriptionGateway,
  readBodyArgs,
  writeBodyArgs,
} from './github-pr-description.js';

const target = { repo: 'owner/name', number: 7 };

describe('github-pr-description argv', () => {
  it('builds read and write argv', () => {
    expect(readBodyArgs(target)).toEqual([
      'pr', 'view', '7', '--repo', 'owner/name', '--json', 'body', '--jq', '.body',
    ]);
    expect(writeBodyArgs(target, 'hello')).toEqual([
      'pr', 'edit', '7', '--repo', 'owner/name', '--body', 'hello',
    ]);
  });
});

describe('createGithubDescriptionGateway', () => {
  it('reads the body and trims a trailing newline', async () => {
    const gw = createGithubDescriptionGateway(
      async () => ({ code: 0, stdout: 'the body\n', stderr: '' }),
      target,
    );
    expect(await gw.getBody()).toBe('the body');
  });

  it('throws when reading fails', async () => {
    const gw = createGithubDescriptionGateway(
      async () => ({ code: 1, stdout: '', stderr: 'boom' }),
      target,
    );
    await expect(gw.getBody()).rejects.toThrow('boom');
  });

  it('throws a default message when reading fails without stderr', async () => {
    const gw = createGithubDescriptionGateway(
      async () => ({ code: 1, stdout: '', stderr: '' }),
      target,
    );
    await expect(gw.getBody()).rejects.toThrow('Failed to read GitHub PR #7');
  });

  it('writes the body', async () => {
    let sent: string[] | null = null;
    const gw = createGithubDescriptionGateway(
      async (args) => ((sent = args), { code: 0, stdout: '', stderr: '' }),
      target,
    );
    await gw.setBody('new');
    expect(sent).toEqual(writeBodyArgs(target, 'new'));
  });

  it('throws when writing fails', async () => {
    const gw = createGithubDescriptionGateway(
      async () => ({ code: 1, stdout: '', stderr: '' }),
      target,
    );
    await expect(gw.setBody('x')).rejects.toThrow('Failed to update GitHub PR #7');
  });

  it('throws the stderr message when writing fails', async () => {
    const gw = createGithubDescriptionGateway(
      async () => ({ code: 1, stdout: '', stderr: 'nope' }),
      target,
    );
    await expect(gw.setBody('x')).rejects.toThrow('nope');
  });
});
