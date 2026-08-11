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
    expect(parseGithubApproval(JSON.stringify({ user: { login: 'alice' } }))).toEqual({
      approved: true,
      state: 'approved',
      reviewer: 'alice',
    });
  });

  it('returns a result without reviewer for invalid or incomplete JSON', () => {
    expect(parseGithubApproval('{')).toEqual({
      approved: true,
      state: 'approved',
    });
    expect(parseGithubApproval(JSON.stringify({ user: {} }))).toEqual({
      approved: true,
      state: 'approved',
    });
  });
});

describe('createGithubApprovalGateway', () => {
  it('approves the pull request', async () => {
    const calls: string[][] = [];
    const gw = createGithubApprovalGateway(async (args) => {
      calls.push(args);
      return ok(JSON.stringify({ user: { login: 'alice' } }));
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
