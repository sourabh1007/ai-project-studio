import { useCallback, useEffect, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import type { ReviewBoard, ReviewDiscussion, ReviewPublication } from '../../lib/types.js';

interface LiveReviewContext {
  featureId: string;
  runId?: string;
  discussion?: ReviewDiscussion;
  publications: ReviewPublication[];
  publicationsLoading: boolean;
  publicationsError: string | null;
}

export function useReviewLiveContext(featureId: string, board: ReviewBoard | null) {
  const api = useApi();
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<LiveReviewContext>({
    featureId, publications: [], publicationsLoading: false, publicationsError: null,
  });
  const runId = board?.run?.id;
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    if (!board) return;
    const hasPublications = Boolean(runId && api.getReviewBoardPublications);
    setSnapshot((previous) => ({
      ...(previous.featureId === featureId && previous.runId === runId ? previous : {
        featureId, runId, publications: [], discussion: undefined,
      }),
      publicationsLoading: hasPublications, publicationsError: null,
    }));
    if (api.getReviewBoardDiscussion) {
      void api.getReviewBoardDiscussion(featureId).then((discussion) => {
        if (active) setSnapshot((previous) => ({ ...previous, discussion }));
      }).catch((cause) => {
        if (active) setSnapshot((previous) => ({
          ...previous, discussion: { matches: {}, warnings: [
            cause instanceof Error ? cause.message : 'Live PR discussion is unavailable.',
          ] },
        }));
      });
    }
    if (hasPublications) {
      void api.getReviewBoardPublications(featureId).then((publications) => {
        if (active) setSnapshot((previous) => ({ ...previous, publications, publicationsLoading: false }));
      }).catch((cause) => {
        if (active) setSnapshot((previous) => ({
          ...previous, publicationsLoading: false,
          publicationsError: cause instanceof Error ? cause.message : 'Could not restore publication history.',
        }));
      });
    }
    return () => { active = false; };
  }, [api, featureId, runId, board?.run?.revision, board?.pull.headSha, Boolean(board), revision]);
  useEffect(() => {
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refresh]);
  const updatePublication = useCallback((record: ReviewPublication) => {
    setSnapshot((previous) => previous.featureId !== featureId || previous.runId !== runId ? previous : {
      ...previous, publications: [...previous.publications.filter((entry) => entry.key !== record.key &&
        !(record.input.publicationKey && entry.input.publicationKey === record.input.publicationKey)), record],
    });
  }, [featureId, runId]);
  const current = snapshot.featureId === featureId && snapshot.runId === runId ? snapshot : {
    featureId, runId, publications: [], publicationsLoading: Boolean(runId && api.getReviewBoardPublications), publicationsError: null,
    discussion: undefined,
  };
  return { ...current, refresh, updatePublication };
}
