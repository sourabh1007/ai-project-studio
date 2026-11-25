import type { MetaUsageSnapshot } from './meta-runner.js';

export interface PromptContextEvent {
  eventId: string;
  promptRefs: readonly string[];
  sessionId: string;
  providerId: string;
  kind: 'context-prepared' | 'context-injected';
  recordedAt: string;
}

export interface PromptUsageEvent {
  eventId: string;
  promptRefs: string[];
  sessionId: string | null;
  providerId: string | null;
  kind: 'request' | PromptContextEvent['kind'];
  recordedAt: string;
  state: string;
  usage: MetaUsageSnapshot | null;
}

export interface PromptUsageSnapshot {
  events: PromptUsageEvent[];
  limited: boolean;
  maxEvents: number;
}

export interface PromptUsageRepo {
  recordContext(event: PromptContextEvent): void;
  read(filter: { from: string; to: string; promptRef?: string; excludeProviderId?: string }, limit: number): PromptUsageSnapshot;
}
