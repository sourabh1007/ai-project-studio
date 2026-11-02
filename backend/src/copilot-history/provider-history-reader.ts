import type { PromptHistoryReader } from './copilot-history-contract.js';

export interface ProviderHistoryReaderDeps {
  sessions: { get(id: string): { provider: string } | null };
  readers: ReadonlyMap<string, PromptHistoryReader>;
}

/** History follows immutable session attribution, never the active execution provider. */
export function createProviderHistoryReader(deps: ProviderHistoryReaderDeps): PromptHistoryReader {
  return {
    read(sessionIds) {
      const groups = new Map<PromptHistoryReader, string[]>();
      for (const id of new Set(sessionIds)) {
        const session = deps.sessions.get(id);
        const reader = session && deps.readers.get(session.provider);
        if (!reader) continue;
        const ids = groups.get(reader) ?? [];
        ids.push(id);
        groups.set(reader, ids);
      }
      const histories = new Map([...groups].flatMap(([reader, ids]) =>
        reader.read(ids).filter((history) => ids.includes(history.sessionId)).map((history) => [history.sessionId, history] as const)));
      return [...new Set(sessionIds)].flatMap((id) => {
        const history = histories.get(id);
        return history ? [history] : [];
      });
    },
    prompts(sessionId) {
      const session = deps.sessions.get(sessionId);
      return session ? deps.readers.get(session.provider)?.prompts(sessionId) ?? [] : [];
    },
  };
}
