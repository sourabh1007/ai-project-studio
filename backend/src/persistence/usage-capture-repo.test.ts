import { describe, expect, it } from 'vitest';
import { createDatabase } from './db/connection.js';
import { createUsageCaptureRepo } from './usage-capture-repo.js';
import { createUsageRepo } from './usage-repo.js';
import type { UsageCaptureState } from '../usage/usage-capture-contract.js';
import type { StoredUsage } from '../usage/usage-repo-port.js';

describe('usage capture persistence', () => {
  it('reserves monotonically stable identities, retains acknowledgements, and lists only recoverable captures', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    try {
      db.exec(`INSERT INTO features (id,name,description,created_at) VALUES ('f','feature','','t');
        INSERT INTO sessions (id,feature_id,provider,requested_model,status,kind,prompt,usage_file_path,created_at)
          VALUES ('s','f','provider','auto','running','dev','','','t')`);
      const captures = createUsageCaptureRepo(db);
      expect(captures.get('s')).toBeNull();
      const state: UsageCaptureState = {
        sessionId: 's',
        sourceId: 'source',
        cursor: null,
        replayCursor: null,
        finalScan: false,
        replayClean: false,
        sourceDone: false,
        replayDone: false,
        status: 'pending',
        reason: 'not-started',
      };
      captures.save(state);
      const event: StoredUsage = {
        sessionId: 's', featureId: 'f', turnIndex: 40, provider: 'provider', requestedModel: 'auto',
        resolvedModel: 'm', operation: 'chat', inputTokens: 1, outputTokens: 2, reasoningOutputTokens: 0,
        cost: 3, credits: 3, nanoAiu: 3e9, kind: 'dev', serviceRequestId: null, startedAt: 'old', endedAt: 'old',
      };
      createUsageRepo(db).saveAll([event]);
      expect(captures.reserve('s', 'old', event)).toMatchObject({
        turnIndex: 40,
        fingerprint: null,
        event: {
          sessionId: 's',
          featureId: 'f',
          turnIndex: 40,
          inputTokens: 1,
          outputTokens: 2,
        },
      });

      captures.acknowledge('s', 'old', 'saved');
      expect(captures.reserve('s', 'old', event)).toMatchObject({
        turnIndex: 40,
        fingerprint: 'saved',
        event: {
          sessionId: 's',
          featureId: 'f',
          turnIndex: 40,
        },
      });
      expect(captures.reserve('s', 'new', { ...event, startedAt: 'new' }).turnIndex).toBe(41);
      expect(captures.reserve('s', 'next', { ...event, startedAt: 'next' }).turnIndex).toBe(42);
      captures.save({ ...state, cursor: 'source-cursor', status: 'retrying', reason: 'source-locked' });
      expect(captures.listUnfinished()).toEqual([{
        ...state,
        cursor: 'source-cursor',
        replayCursor: null,
        status: 'retrying',
        reason: 'source-locked',
      }]);
      captures.save({ ...state, status: 'complete', reason: null });
      expect(captures.get('s')).toEqual({ ...state, replayCursor: null, status: 'complete', reason: null });
      expect(captures.listUnfinished()).toEqual([]);
    } finally { db.close(); }
  });

  it('deletes capture state and reserved identities for a removed session', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    try {
      db.exec(`INSERT INTO features (id,name,description,created_at) VALUES ('f','feature','','t');
        INSERT INTO sessions (id,feature_id,provider,requested_model,status,kind,prompt,usage_file_path,created_at)
          VALUES ('s','f','provider','auto','running','dev','','','t')`);
      const captures = createUsageCaptureRepo(db);
      captures.save({
        sessionId: 's',
        sourceId: 'source',
        cursor: '5',
        replayCursor: null,
        finalScan: false,
        replayClean: false,
        sourceDone: false,
        replayDone: false,
        status: 'retrying',
        reason: 'source-locked',
      });
      captures.reserve('s', 'row-1', {
        sessionId: 's',
        featureId: 'f',
        turnIndex: 0,
        provider: 'provider',
        requestedModel: 'auto',
        resolvedModel: 'm',
        operation: 'chat',
        inputTokens: 1,
        outputTokens: 2,
        reasoningOutputTokens: 0,
        cost: 3,
        nanoAiu: 3e9,
        serviceRequestId: null,
        startedAt: 'old',
        endedAt: 'old',
      });

      captures.deleteBySession('s');

      expect(captures.get('s')).toBeNull();
      expect(captures.listUnfinished()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
