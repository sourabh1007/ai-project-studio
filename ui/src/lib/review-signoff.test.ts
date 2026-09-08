import { describe, expect, it } from 'vitest';
import {
  allPerspectivesReviewed,
  beginSignoffIdentityRefresh,
  canCertifySignoff,
  clearPerspectivesReviewed,
  emptySignoff,
  isPerspectiveReviewed,
  parseSignoff,
  perspectiveBadgeLabel,
  perspectiveVerdictLabel,
  recordSignoffIdentityFailure,
  resolveSignoffIdentity,
  reviewedCount,
  signoffNoticeText,
  syncSignoffIdentity,
  withPerspectiveReviewed,
  withPrReviewCleared,
  withPrReviewed,
} from './review-signoff.js';
import type { ReviewBoard } from './types.js';

const AT = '2024-01-01T00:00:00.000Z';
const AT2 = '2024-02-02T00:00:00.000Z';
const AT3 = '2024-03-03T00:00:00.000Z';

function board(
  headSha: string | null,
  reviewUpdatedAt = AT,
  repoId = 'r1',
): ReviewBoard {
  return {
    featureId: 'f1',
    repoId,
    pull: {
      number: 7,
      title: 'Improve review trust',
      url: 'https://github.com/acme/app/pull/7',
      headSha,
    },
    worktreePath: 'C:\\repo',
    baseBranch: 'main',
    changedFiles: 0,
    model: {
      projectType: 'web',
      projectTypeConfidence: 1,
      primaryLanguages: [],
      secondaryLanguages: [],
      changedComponents: [],
      changedModules: [],
      changedRuntimePaths: [],
      configurationSystems: [],
      testSignals: [],
      deploymentModel: 'desktop',
      contracts: [],
      blastRadiusDimensions: [],
      confidence: 1,
      evidence: [],
    },
    perspectives: [],
    recommendation: 'needs-review',
    summary: { open: 0, blocking: 0, warnings: 0, suggestions: 0 },
    reviewUpdatedAt,
    generatedAt: AT,
  };
}

function reviewedState() {
  let state = syncSignoffIdentity(emptySignoff(), resolveSignoffIdentity(board('sha-a')), AT);
  state = withPerspectiveReviewed(state, 'security', AT2);
  state = withPrReviewed(state, ['security'], AT2);
  return state;
}

describe('emptySignoff', () => {
  it('starts with nothing reviewed', () => {
    expect(emptySignoff()).toEqual({
      perspectives: {},
      prReviewedAt: null,
      identity: null,
      identityStatus: 'unknown',
      identityError: null,
      history: [],
      notice: null,
    });
  });
});

describe('isPerspectiveReviewed / reviewedCount', () => {
  it('reflects which perspectives are signed off', () => {
    const s = withPerspectiveReviewed(emptySignoff(), 'a', AT);
    expect(isPerspectiveReviewed(s, 'a')).toBe(true);
    expect(isPerspectiveReviewed(s, 'b')).toBe(false);
    expect(reviewedCount(s, ['a', 'b', 'c'])).toBe(1);
  });
});

describe('allPerspectivesReviewed', () => {
  it('is false for an empty board', () => {
    expect(allPerspectivesReviewed(emptySignoff(), [])).toBe(false);
  });

  it('is true only when every perspective is signed off', () => {
    let s = withPerspectiveReviewed(emptySignoff(), 'a', AT);
    expect(allPerspectivesReviewed(s, ['a', 'b'])).toBe(false);
    s = withPerspectiveReviewed(s, 'b', AT);
    expect(allPerspectivesReviewed(s, ['a', 'b'])).toBe(true);
  });
});

describe('withPerspectiveReviewed', () => {
  it('sets a sign-off with the given timestamp', () => {
    const s = withPerspectiveReviewed(emptySignoff(), 'a', AT);
    expect(s.perspectives.a).toBe(AT);
  });

  it('clearing a sign-off also invalidates a PR sign-off', () => {
    let s = withPerspectiveReviewed(emptySignoff(), 'a', AT);
    s = withPrReviewed(s, ['a'], AT2);
    const cleared = withPerspectiveReviewed(s, 'a', null);
    expect(cleared.perspectives.a).toBeUndefined();
    expect(cleared.prReviewedAt).toBeNull();
  });
});

describe('clearPerspectivesReviewed', () => {
  it('is a no-op for an empty id list', () => {
    const s = withPerspectiveReviewed(emptySignoff(), 'a', AT);
    expect(clearPerspectivesReviewed(s, [])).toBe(s);
  });

  it('returns the same state when nothing changes', () => {
    expect(clearPerspectivesReviewed(emptySignoff(), ['x', 'y'])).toEqual(
      emptySignoff(),
    );
  });

  it('clears the listed perspectives and any PR sign-off', () => {
    let s = withPerspectiveReviewed(emptySignoff(), 'a', AT);
    s = withPerspectiveReviewed(s, 'b', AT);
    s = withPrReviewed(s, ['a', 'b'], AT2);
    const cleared = clearPerspectivesReviewed(s, ['a']);
    expect(cleared.perspectives.a).toBeUndefined();
    expect(cleared.perspectives.b).toBe(AT);
    expect(cleared.prReviewedAt).toBeNull();
  });
});

describe('withPrReviewed / withPrReviewCleared', () => {
  it('leaves an already-cleared review unchanged', () => {
    const state = emptySignoff();
    expect(withPrReviewCleared(state)).toBe(state);
  });

  it('refuses to mark the PR reviewed until every perspective is signed off', () => {
    const s = withPerspectiveReviewed(emptySignoff(), 'a', AT);
    expect(withPrReviewed(s, ['a', 'b'], AT2)).toBe(s);
  });

  it('marks and clears the PR review', () => {
    let s = withPerspectiveReviewed(emptySignoff(), 'a', AT);
    s = withPrReviewed(s, ['a'], AT2);
    expect(s.prReviewedAt).toBe(AT2);
    expect(withPrReviewCleared(s).prReviewedAt).toBeNull();
  });
});

describe('perspectiveVerdictLabel / perspectiveBadgeLabel', () => {
  it('maps machine statuses to reviewer wording', () => {
    expect(perspectiveVerdictLabel('approved')).toBe('Approve');
    expect(perspectiveVerdictLabel('not-applicable')).toBe('Not applicable');
    expect(perspectiveVerdictLabel('not-started')).toBe('Not started');
    expect(perspectiveVerdictLabel('warning')).toBe('Needs attention');
    expect(perspectiveVerdictLabel('blocked')).toBe('Needs attention');
    expect(perspectiveVerdictLabel('needs-review')).toBe('Needs attention');
  });

  it('reads reviewing while analysing', () => {
    expect(perspectiveBadgeLabel(true, 'approved')).toBe('Reviewing');
    expect(perspectiveBadgeLabel(false, 'approved')).toBe('Approve');
  });
});

describe('parseSignoff', () => {
  it('returns empty for non-objects', () => {
    expect(parseSignoff(null)).toEqual(emptySignoff());
    expect(parseSignoff('nope')).toEqual(emptySignoff());
    expect(parseSignoff(42)).toEqual(emptySignoff());
  });

  it('keeps only valid persisted fields', () => {
    const parsed = parseSignoff({
      perspectives: { a: AT, b: 0, c: '', d: null },
      prReviewedAt: AT2,
      identity: {
        repoId: 'r1',
        prNumber: 7,
        prUrl: 'https://github.com/acme/app/pull/7',
        reviewedCommit: 'abc123',
        evidenceRevision: AT2,
      },
      identityStatus: 'fresh',
      identityError: 'timeout',
      history: [
        {
          archivedAt: AT3,
          reason: 'identity-changed',
          identity: {
            repoId: 'r1',
            prNumber: 7,
            prUrl: 'https://github.com/acme/app/pull/7',
            reviewedCommit: 'old',
            evidenceRevision: AT,
          },
          perspectives: { a: AT },
          prReviewedAt: AT2,
        },
      ],
    });
    expect(parsed.perspectives).toEqual({ a: AT });
    expect(parsed.prReviewedAt).toBe(AT2);
    expect(parsed.identityStatus).toBe('fresh');
    expect(parsed.identity?.reviewedCommit).toBe('abc123');
    expect(parsed.history).toHaveLength(1);
  });

  it.each(['identity-changed', 'legacy-missing-identity'] as const)(
    'round-trips archived approvals and the %s notice',
    (reason) => {
      const previous = reason === 'identity-changed'
        ? reviewedState()
        : { ...emptySignoff(), perspectives: { security: AT }, prReviewedAt: AT2 };
      const changed = syncSignoffIdentity(
        previous,
        resolveSignoffIdentity(board('sha-b', AT2)),
        AT3,
      );

      expect(changed.notice?.reason).toBe(reason);
      expect(parseSignoff(JSON.parse(JSON.stringify(changed)))).toEqual(changed);
      expect(changed.history[0].perspectives).toEqual(previous.perspectives);
      expect(changed.perspectives).toEqual({});
      expect(changed.prReviewedAt).toBeNull();
      expect(signoffNoticeText(changed)).toMatch(
        reason === 'identity-changed' ? /preserved as history/i : /review again/i,
      );
      const acknowledged = withPerspectiveReviewed(changed, 'security', AT3);
      expect(acknowledged.notice).toBeNull();
      expect(acknowledged.history).toEqual(changed.history);
    },
  );

  it('rejects malformed persisted identities even when marked fresh', () => {
    const previous = reviewedState();
    const parsed = parseSignoff({ ...previous, identity: {} });
    expect(parsed.identity).toBeNull();
    expect(canCertifySignoff(parsed)).toBe(false);
    expect(parsed.perspectives).toEqual(previous.perspectives);
  });

  it.each([
    null,
    'invalid',
    {},
    { reason: 'unsupported', at: AT },
    { reason: 'identity-changed', at: 123 },
    { reason: 'identity-changed', at: '' },
    { reason: 'legacy-missing-identity', at: null },
  ])('discards a malformed notice without losing approvals: %j', (notice) => {
    const previous = reviewedState();
    expect(parseSignoff({ ...previous, notice })).toEqual(previous);
  });

  it.each([
    null,
    'invalid',
    {},
    { reason: 'unsupported', archivedAt: AT },
    { reason: 'identity-changed', archivedAt: 123 },
    { reason: 'identity-changed', archivedAt: '' },
    { reason: 'legacy-missing-identity', archivedAt: null },
  ])('discards a malformed archive but retains valid history: %j', (invalid) => {
    const changed = syncSignoffIdentity(
      reviewedState(),
      resolveSignoffIdentity(board('sha-b')),
      AT3,
    );
    const parsed = parseSignoff({
      ...changed,
      history: [invalid, ...changed.history, invalid],
    });

    expect(parsed).toEqual(changed);
    expect(parsed.perspectives).toEqual({});
    expect(parsed.prReviewedAt).toBeNull();
  });
});

describe('review signoff identity', () => {
  it('explains unknown identity without requiring an error message', () => {
    expect(signoffNoticeText(emptySignoff())).toMatch(
      /could not refresh.*temporarily disabled/i,
    );
  });

  it('updates an unapproved identity without manufacturing approval history', () => {
    const initial = syncSignoffIdentity(
      emptySignoff(),
      resolveSignoffIdentity(board('sha-a')),
      AT,
    );
    const changed = syncSignoffIdentity(
      initial,
      resolveSignoffIdentity(board('sha-b')),
      AT2,
    );
    expect(changed.identity?.reviewedCommit).toBe('sha-b');
    expect(changed.identityStatus).toBe('fresh');
    expect(changed.perspectives).toEqual({});
    expect(changed.prReviewedAt).toBeNull();
    expect(changed.history).toEqual([]);
    expect(signoffNoticeText(changed)).toBeNull();
  });

  it('builds the approval identity from the authoritative board payload', () => {
    expect(resolveSignoffIdentity(board('abc123', AT2))).toEqual({
      repoId: 'r1',
      prNumber: 7,
      prUrl: 'https://github.com/acme/app/pull/7',
      reviewedCommit: 'abc123',
      evidenceRevision: AT2,
    });
  });

  it('fails closed when the board identity is unavailable', () => {
    const synced = syncSignoffIdentity(
      emptySignoff(),
      resolveSignoffIdentity(board(null)),
      AT,
    );
    expect(canCertifySignoff(synced)).toBe(false);
    expect(synced.identityStatus).toBe('missing');
    expect(signoffNoticeText(synced)).toMatch(/unavailable/i);
  });

  it('preserves approvals while a refresh is in progress or transiently fails', () => {
    const refreshing = beginSignoffIdentityRefresh(reviewedState());
    expect(refreshing.identityStatus).toBe('refreshing');
    expect(canCertifySignoff(refreshing)).toBe(false);
    expect(signoffNoticeText(refreshing)).toMatch(/temporarily disabled/i);

    const failed = recordSignoffIdentityFailure(refreshing, 'timed out');
    expect(failed.perspectives.security).toBeTruthy();
    expect(failed.prReviewedAt).toBeTruthy();
    expect(failed.identityStatus).toBe('unknown');
    expect(signoffNoticeText(failed)).toMatch(/timed out/i);
  });

  it('restores certification after a successful same-identity retry', () => {
    const failed = recordSignoffIdentityFailure(reviewedState(), 'network');
    const recovered = syncSignoffIdentity(
      failed,
      resolveSignoffIdentity(board('sha-a')),
      AT3,
    );
    expect(recovered.identityStatus).toBe('fresh');
    expect(canCertifySignoff(recovered)).toBe(true);
    expect(recovered.perspectives.security).toBeTruthy();
    expect(recovered.prReviewedAt).toBeTruthy();
    expect(recovered.history).toHaveLength(0);
  });

  it('invalidates changed identities and preserves prior decisions as history', () => {
    const changed = syncSignoffIdentity(
      reviewedState(),
      resolveSignoffIdentity(board('sha-b', AT2)),
      AT3,
    );
    expect(changed.identity?.reviewedCommit).toBe('sha-b');
    expect(changed.perspectives).toEqual({});
    expect(changed.prReviewedAt).toBeNull();
    expect(changed.history).toHaveLength(1);
    expect(changed.notice?.reason).toBe('identity-changed');
  });

  it('invalidates legacy approvals without identity and preserves them as history', () => {
    const legacy = {
      ...emptySignoff(),
      perspectives: { security: AT },
      prReviewedAt: AT2,
    };
    const synced = syncSignoffIdentity(
      legacy,
      resolveSignoffIdentity(board('abc123')),
      AT3,
    );
    expect(synced.prReviewedAt).toBeNull();
    expect(synced.perspectives).toEqual({});
    expect(synced.history).toHaveLength(1);
    expect(synced.notice?.reason).toBe('legacy-missing-identity');
  });
});
