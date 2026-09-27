import { describe, expect, it } from 'vitest';
import type { GhCommandResult } from '../github-auth/github-auth-service.js';
import {
  approvePrArgs,
  createGithubApprovalGateway,
  parseGithubApproval,
} from './github-pr-approval.js';

const TARGET = { repo: 'acme/widgets', number: 7 };

function ok(stdout: string): GhCommandResult {
  return { code: 0, stdout, stderr: '' };
}

function fail(stderr: string): GhCommandResult {
  return { code: 1, stdout: '', stderr };
}

describe('approvePrArgs', () => {
  it('builds a GitHub REST approval request', () => {
    expect(approvePrArgs(TARGET)).toEqual([
      'api',
      '--method',
      'POST',
      '/repos/acme/widgets/pulls/7/reviews',
      '-f',
      'event=APPROVE',
    ]);
  });
});

describe('parseGithubApproval', () => {
  it('returns the reviewer when GitHub includes it', () => {
    expect(parseGithubApproval(JSON.stringify({ state: 'APPROVED', user: { login: 'alice' } }))).toEqual({
      approved: true,
      state: 'approved',
      reviewer: 'alice',
    });
  });

  it('requires provider confirmation and tolerates absent reviewer names', () => {
    for (const response of ['{', 'null', '{}', '{"state":"COMMENTED"}']) {
      expect(() => parseGithubApproval(response)).toThrow('did not confirm');
    }
    expect(parseGithubApproval(JSON.stringify({ state: 'APPROVED', user: {} }))).toEqual({
      approved: true,
      state: 'approved',
    });
    expect(parseGithubApproval('{"state":"APPROVED"}').approved).toBe(true);
    expect(parseGithubApproval('{"state":"APPROVED","user":{"login":""}}').approved).toBe(true);
  });
});

describe('createGithubApprovalGateway', () => {
  const detail = { state: 'open', head: { sha: 'head' } };
  function guarded(responses: unknown[]) {
    const calls: string[][] = [];
    const gw = createGithubApprovalGateway(async (args) => {
      calls.push(args);
      return ok(JSON.stringify(responses.shift()));
    }, TARGET);
    return { gw, calls };
  }

  it('checks the live head without sending any approval', async () => {
    const { gw, calls } = guarded([detail]);
    await expect(gw.getHeadSha()).resolves.toBe('head');
    expect(calls).toEqual([['api', '/repos/acme/widgets/pulls/7']]);
  });

  it.each([null, {}, { state: 'closed' }, { state: 'open', head: {} }, { state: 'open', head: { sha: '' } }])(
    'refuses unverifiable or closed pull details %j', async (response) => {
      const { gw } = guarded([response]);
      await expect(gw.getHeadSha()).rejects.toThrow('head could not be verified');
    },
  );

  it.each(['boom', ''])('propagates failed head reads: %s', async (message) => {
    const gw = createGithubApprovalGateway(async () => fail(message), TARGET);
    await expect(gw.getHeadSha()).rejects.toThrow(message || 'Could not verify');
  });

  it('rejects malformed read responses', async () => {
    const gw = createGithubApprovalGateway(async () => ok('{'), TARGET);
    await expect(gw.getHeadSha()).rejects.toThrow('invalid approval status');
  });

  it('binds new approval to the reviewed commit', async () => {
    const { gw, calls } = guarded([detail, { login: 'alice' }, [[]], { state: 'APPROVED', user: { login: 'alice' } }]);
    await expect(gw.approve('head')).resolves.toMatchObject({ approved: true });
    expect(calls.at(-1)).toEqual(approvePrArgs(TARGET, 'head'));
  });

  it('does not create duplicate GitHub approvals for the same commit', async () => {
    const { gw, calls } = guarded([detail, { login: 'alice' }, [[
      { user: { login: 'bob' }, state: 'APPROVED', commit_id: 'head' },
      { user: { login: 'alice' }, state: 'APPROVED', commit_id: 'head' },
      { user: { login: 'alice' }, state: 'COMMENTED', commit_id: 'head' },
    ]]]);
    await expect(gw.approve('head')).resolves.toEqual({
      approved: true, state: 'approved', reviewer: 'alice', alreadyApproved: true,
    });
    expect(calls).toHaveLength(3);
  });

  it.each([
    { state: 'CHANGES_REQUESTED', commit_id: 'head' },
    { state: 'APPROVED', commit_id: 'old' },
  ])('does not mistake old or non-approval reviews for approval: %j', async (prior) => {
    const { gw, calls } = guarded([detail, { login: 'alice' }, [[{ user: { login: 'alice' }, ...prior }]], { state: 'APPROVED' }]);
    await expect(gw.approve('head')).resolves.toMatchObject({ approved: true });
    expect(calls).toHaveLength(4);
  });

  it('blocks a stale expected head', async () => {
    const { gw, calls } = guarded([detail]);
    await expect(gw.approve('old')).rejects.toThrow('head changed');
    expect(calls).toHaveLength(1);
  });

  it.each([null, {}, { login: '' }])('rejects unknown reviewer identity: %j', async (identity) => {
    const { gw } = guarded([detail, identity]);
    await expect(gw.approve('head')).rejects.toThrow('reviewer identity');
  });

  it.each([{}, [{}]])('rejects malformed review listings: %j', async (reviews) => {
    const { gw } = guarded([detail, { login: 'alice' }, reviews]);
    await expect(gw.approve('head')).rejects.toThrow('existing GitHub reviews');
  });
  it('approves the pull request', async () => {
    const calls: string[][] = [];
    const gw = createGithubApprovalGateway(async (args) => {
      calls.push(args);
      return ok(JSON.stringify({ state: 'APPROVED', user: { login: 'alice' } }));
    }, TARGET);
    await expect(gw.approve()).resolves.toEqual({
      approved: true,
      state: 'approved',
      reviewer: 'alice',
    });
    expect(calls[0]).toEqual(approvePrArgs(TARGET));
  });

  it('throws a ProviderError when gh exits non-zero', async () => {
    const gw = createGithubApprovalGateway(async () => fail('boom'), TARGET);
    await expect(gw.approve()).rejects.toThrow(/boom/);
  });

  it('uses a default message when stderr is empty', async () => {
    const gw = createGithubApprovalGateway(async () => fail('   '), TARGET);
    await expect(gw.approve()).rejects.toThrow(/Failed to approve GitHub PR #7/);
  });
});
