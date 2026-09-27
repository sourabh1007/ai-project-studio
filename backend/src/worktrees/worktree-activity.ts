import { basename, dirname, join } from 'node:path';
import type { ApplicationWorkScope } from '../lifecycle/application-work.js';
import type { Session } from '../session/session-contract.js';
import { canonicalPath, isWithin } from '../resources/storage-scanner.js';

export interface WorktreeActivityDeps {
  repositories(): Array<{ id: string; localPath: string }>;
  sessions(): Array<Pick<Session, 'id' | 'featureId' | 'status' | 'kind' | 'worktreePath'>>;
  feature(id: string): { repoId?: string | null; checkoutPath?: string | null } | null;
  reviewPath(featureId: string): string | null;
  liveTerminal(sessionId: string): boolean;
  scopes(): ApplicationWorkScope[];
  metaScopes(): Array<{ featureId: string; originSessionId: string | null; sessionIds: string[] }>;
}

/** Unknown producer attribution fails closed; this guard never stops or deletes work. */
export function createWorktreeActivityGuard(deps: WorktreeActivityDeps): (path: string) => boolean {
  return (path) => {
    try {
      const repos = deps.repositories();
      const same = (candidate: string): boolean =>
        canonicalPath(candidate) === canonicalPath(path) || isWithin(candidate, path);
      if (repos.some((repo) => same(repo.localPath))) return true;
      const sessions = deps.sessions();
      const featureMatches = (id: string, conservative: boolean): boolean => {
        const feature = deps.feature(id);
        const review = deps.reviewPath(id);
        if (feature?.checkoutPath && same(feature.checkoutPath) || review && same(review)) return true;
        const repo = repos.find((repo) => repo.id === feature?.repoId);
        if (!repo) return !feature?.checkoutPath && !review;
        // Meta/queued producers can acquire another checkout before publishing
        // its cwd. Until then protect the owning repo's managed directory.
        return conservative && isWithin(path, join(dirname(repo.localPath), '.ai-worktrees')) &&
          basename(canonicalPath(path)).startsWith(`${basename(canonicalPath(repo.localPath))}-`);
      };
      const sessionMatches = (id: string): boolean => {
        const session = sessions.find((session) => session.id === id);
        return !session || (session.worktreePath ? same(session.worktreePath) : featureMatches(session.featureId, session.kind === 'meta'));
      };
      if (sessions.some((session) =>
        (session.status === 'running' || deps.liveTerminal(session.id)) && sessionMatches(session.id))) return true;
      for (const scope of deps.scopes()) {
        const featureIds = [...(scope.featureIds ?? []), ...(scope.featureId ? [scope.featureId] : [])];
        const sessionIds = [...(scope.sessionIds ?? []), ...(scope.sessionId ? [scope.sessionId] : [])];
        if (featureIds.some((id) => featureMatches(id, true)) || sessionIds.some(sessionMatches)) return true;
      }
      return deps.metaScopes().some((scope) => featureMatches(scope.featureId, true) ||
        scope.sessionIds.some(sessionMatches) || (scope.originSessionId !== null && sessionMatches(scope.originSessionId)));
    } catch { return true; }
  };
}
