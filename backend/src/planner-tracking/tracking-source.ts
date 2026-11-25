import { createHash } from 'node:crypto';
import type { PromptHistoryReader } from '../copilot-history/copilot-history-contract.js';
import type { WorkEvidence, WorkSnapshot, WorkTrackingSource } from './tracking-contract.js';

export interface TrackingContext {
  featureId: string;
  repoId: string | null;
  name: string;
  sessions: { id: string; provider: string }[];
  recorded: WorkEvidence[];
}
export interface TrackingContextReader {
  page(after: string, since: string): string[];
  context(featureId: string): TrackingContext | null;
  exists(featureId: string, repoId: string | null): boolean;
}

export function createWorkTrackingSource(deps: {
  context: TrackingContextReader; history: PromptHistoryReader;
}): WorkTrackingSource {
  return {
    page: (after, since) => deps.context.page(after, since),
    exists: (featureId, repoId) => deps.context.exists(featureId, repoId),
    async read(featureId, signal): Promise<WorkSnapshot | null> {
      const context = deps.context.context(featureId);
      if (!context) return null;
      const evidence: WorkEvidence[] = [];
      let remaining = 48000;
      const append = (item: WorkEvidence) => {
        if (remaining <= 0) return;
        const text = item.text.slice(0, Math.min(item.kind === 'agent' ? 3000 : 4000, remaining));
        remaining -= text.length + item.label.length + 200;
        evidence.push({ ...item, text, truncated: item.text.length > text.length });
      };
      for (const item of context.recorded) append(item);
      for (const session of context.sessions.slice(0, 4)) {
        signal.throwIfAborted();
        if (!deps.history.recentPrompts) throw new Error('Bounded history is unavailable');
        const prompts = await deps.history.recentPrompts(session.id, 4);
        signal.throwIfAborted();
        for (const turn of [...prompts].reverse()) {
          const identity = createHash('sha256').update(`${session.id}:${turn.at}:${turn.text}`).digest('hex');
          const base = { at: turn.at, sessionId: session.id, label: `${session.provider} session prompt` };
          append({ ...base, id: `prompt:${identity}`, kind: 'prompt', text: turn.text, completed: false });
          for (const match of turn.text.slice(0, 8000).matchAll(/https:\/\/(?:github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+|dev\.azure\.com\/[^\s]+\/pullrequest\/\d+|[a-z0-9-]+\.visualstudio\.com\/[^\s]+\/pullrequest\/\d+)/gi)) {
            const url = match[0].toLowerCase();
            append({
              ...base, id: `pr:${url}`, kind: 'pr', label: 'PR mentioned in prompt (not independently verified)',
              text: url, completed: false,
            });
          }
          if (turn.response && turn.status === 'answered') append({
            ...base, id: `response:${identity}`, kind: 'response', label: `${session.provider} reported response`,
            text: turn.response, completed: turn.status === 'answered',
          });
        }
      }
      return { featureId, repoId: context.repoId, name: context.name, evidence };
    },
  };
}
