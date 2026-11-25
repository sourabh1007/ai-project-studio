import type { ReviewEvidence, ReviewFinding, FindingSeverity } from './review-board-contract.js';
import type { PrReview } from '../pr-review/pr-review-contract.js';

export interface ReviewOptions {
  model?: string;
  perspectiveIds?: string[];
  skillIds?: string[];
  businessContext?: string;
}

export interface ReviewSkillContext {
  id: string;
  name: string;
  source: string;
  content: string;
  fingerprint: string;
  perspectiveIds: string[];
  contentStatus?: 'not-loaded' | 'unavailable';
}

export interface ReviewRepositorySkills {
  repoId: string;
  repository: { name: string; remoteUrl: string } | null;
  targetBranch: string | null;
  baseSha?: string;
  skills: ReviewSkillContext[];
  warnings: string[];
}

export interface ReviewContextSnapshot {
  resources?: ReviewContextResource[];
  discovery?: Pick<ReviewContextDiscovery, 'status' | 'sessionId' | 'contextFingerprint'>;
  requirements?: ReviewRequirement[];
  fingerprint: string;
  skills: ReviewSkillContext[];
  businessRequirements: string;
  evidence: string;
  warnings: string[];
  baseSha?: string;
  mergeBaseSha?: string;
  targetBranch?: string;
}

export interface ReviewContextDiscovery {
  status: 'loaded' | 'empty' | 'failed';
  headSha: string | null;
  graphGeneratedAt: string | null;
  contextFingerprint: string;
  generatedAt: string;
  summary: string;
  requirements: Array<{
    text: string;
    kind: 'documented' | 'inferred';
    source: string;
    quote: string;
  }>;
  questions: string[];
  sessionId?: string;
  requestedModel?: string;
  resolvedModel?: string | null;
  error?: string;
  resources?: ReviewContextResource[];
  resourceWarnings?: string[];
}

export interface ReviewContextResource {
  id: string;
  source: string;
  content: string;
  documented: boolean;
}

export interface ReviewContextResourcesPort {
  collect(review: PrReview, selection: { providerId: string; model: string },
    signal?: AbortSignal): Promise<{ sources: ReviewContextResource[]; warnings: string[] }>;
}

export interface ReviewContextDiscoveryPort {
  discover(review: PrReview, context: ReviewContextSnapshot,
    selection: { providerId: string; model: string; runId?: string },
    signal?: AbortSignal): Promise<ReviewContextDiscovery>;
}

export interface ReviewRun {
  schemaVersion?: 2;
  findingEvents?: ReviewFindingEvent[];
  id: string;
  revision: number;
  status: 'prepared' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  options: ReviewOptions;
  providerId: string;
  model: string;
  perspectiveIds: string[];
  context: ReviewContextSnapshot;
  headSha: string | null;
  graphGeneratedAt: string | null;
  startedAt: string;
  finishedAt?: string;
  failures: Record<string, string>;
  prompts?: Record<string, { common: string; focus: string; issueFormat: string }>;
  discussion?: import('./review-board-prompt.js').ExistingCommentThread[];
}

export interface ReviewFindingGroup {
  disposition?: 'open' | 'dismissed' | 'fix-verified';
  dispositionReason?: string;
  id: string;
  finding: ReviewFinding;
  observations: ReviewFinding[];
  perspectiveIds: string[];
  skillIds: string[];
}

export interface ReviewRequirement {
  id: string;
  text: string;
  source: string;
  fingerprint: string;
  priority: number;
}

export interface ReviewRequirementRow {
  requirement: ReviewRequirement;
  assessment: 'supported' | 'violated' | 'not-assessed' | 'ambiguous';
  explanation: string;
  evidence: ReviewEvidence[];
  findingIds: string[];
}

export interface ReviewFindingEvent {
  id: string;
  action: 'merge' | 'split' | 'disposition' | 'severity' | 'undo';
  observationIds: string[];
  reason: string;
  at: string;
  disposition?: 'open' | 'dismissed' | 'fix-verified';
  severity?: FindingSeverity;
  targetEventId?: string;
}

export interface ReviewFindingAction {
  expectedRunId: string;
  expectedAssessmentRevision: number;
  action: ReviewFindingEvent['action'];
  groupIds: string[];
  reason: string;
  disposition?: ReviewFindingEvent['disposition'];
  severity?: FindingSeverity;
  targetEventId?: string;
}

export interface ReviewDiscussionResult {
  matches: Record<string, Array<{ id: string; status: 'active' | 'resolved'; url: string }>>;
  warnings: string[];
}

export interface ReviewContextPort {
  collect(review: PrReview, options: ReviewOptions, signal?: AbortSignal): Promise<ReviewContextSnapshot>;
  inspectSkills?(review: PrReview, signal?: AbortSignal): Promise<Pick<ReviewContextSnapshot, 'skills' | 'warnings' | 'baseSha'>>;
}
