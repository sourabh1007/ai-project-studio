/**
 * Contract for the generic Project Review Board.
 *
 * The board reviews *any* change from multiple engineering perspectives. Nothing
 * here is tied to a specific product, repository, service, language, config
 * system, telemetry stack or deployment model — every project-specific fact is
 * *derived from evidence* (the changed files, the PR description, the already
 * computed change graph) at runtime. See `project-discovery.ts`.
 */

/** How confident a review signal is: approved → blocked, worst-case unknown. */
export type ReviewStatus =
  | 'not-started'
  | 'needs-review'
  | 'warning'
  | 'blocked'
  | 'approved'
  | 'not-applicable';

/** Coarse risk band attached to a perspective or blast-radius dimension. */
export type ReviewRisk = 'low' | 'medium' | 'high' | 'critical' | 'unknown';

/** Severity of a single review finding. */
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'suggestion';

/** Where a perspective came from: an always-present core lens, or one that the
 * discovery engine added because the change's evidence made it relevant. */
export type PerspectiveSource = 'core' | 'detected';

/**
 * One piece of evidence backing a detection, score, risk marker or finding.
 * Every derived fact must cite at least one of these so the reviewer can see
 * *why* the board concluded what it did — and challenge it.
 */
export interface ReviewEvidence {
  /** The file, document, manifest or signal the conclusion was drawn from. */
  source: string;
  /** Plain-language reason this source supports the conclusion. */
  reason: string;
  /** 0..1 confidence in this single piece of evidence. */
  confidence: number;
  /** True when read directly from the change; false when inferred/heuristic. */
  direct: boolean;
}

/** A named thing the discovery engine detected, with its supporting evidence. */
export interface DetectedItem {
  name: string;
  evidence: ReviewEvidence[];
}

/** A review lens the board will render, with why it was selected. */
export interface PerspectiveSpec {
  id: string;
  name: string;
  /** Evidence-grounded reason this perspective is on the board. */
  why: string;
  source: PerspectiveSource;
}

/**
 * The structured, evidence-derived understanding of the project the change
 * belongs to. Produced entirely from change evidence — never hardcoded.
 */
export interface ProjectModel {
  /** Derived project type label (e.g. "Backend service"); never assumed. */
  projectType: string;
  /** 0..1 confidence in the project-type classification. */
  projectTypeConfidence: number;
  /** Most-used changed languages, most frequent first. */
  primaryLanguages: string[];
  /** Remaining changed languages. */
  secondaryLanguages: string[];
  /** Names of the project/module boxes the change touched. */
  changedComponents: string[];
  /** Finer-grained module labels the change touched. */
  changedModules: string[];
  /** Top-level runtime areas (first path segment) the change touched. */
  changedRuntimePaths: string[];
  /** Configuration systems detected among the changed files. */
  configurationSystems: DetectedItem[];
  /** Test signals detected among the changed files. */
  testSignals: DetectedItem[];
  /** Derived deployment model label, or '' when none was detected. */
  deploymentModel: string;
  /** Public/internal contract artifacts detected among the changed files. */
  contracts: DetectedItem[];
  /** Blast-radius dimensions the change plausibly reaches. */
  blastRadiusDimensions: string[];
  /** The dynamic set of perspectives selected for this change. */
  perspectives: PerspectiveSpec[];
  /** 0..1 overall confidence in the derived model. */
  confidence: number;
  /** Every piece of evidence gathered while building the model. */
  evidence: ReviewEvidence[];
}

/** One concrete, evidence-backed observation under a perspective. */
export interface ReviewFinding {
  id: string;
  perspectiveId: string;
  title: string;
  detail: string;
  severity: FindingSeverity;
  status: ReviewStatus;
  evidence: ReviewEvidence[];
}

/** A rendered review lens with its rolled-up status, risk and findings. */
export interface ReviewPerspective {
  id: string;
  name: string;
  why: string;
  source: PerspectiveSource;
  status: ReviewStatus;
  risk: ReviewRisk;
  findings: ReviewFinding[];
}

/** Roll-up counts shown in the board header. */
export interface ReviewBoardSummary {
  open: number;
  blocking: number;
  warnings: number;
  suggestions: number;
}

/** The board-level merge recommendation; never auto-approves. */
export type ReviewRecommendation =
  | 'approve'
  | 'request-changes'
  | 'needs-review';

/** Minimal pull identity echoed onto the board. */
export interface ReviewBoardPull {
  number: number;
  title: string;
  url: string;
}

/**
 * The complete Project Review Board for one change, assembled from the change's
 * existing PR review (diff + change graph) and the derived project model.
 */
export interface ReviewBoard {
  featureId: string;
  pull: ReviewBoardPull;
  worktreePath: string;
  baseBranch: string | null;
  changedFiles: number;
  model: ProjectModel;
  perspectives: ReviewPerspective[];
  recommendation: ReviewRecommendation;
  summary: ReviewBoardSummary;
  /** When this board snapshot was assembled. */
  generatedAt: string;
}

/** A changed node the discovery engine reasons over (subset of the change graph). */
export interface DiscoveryNode {
  path: string;
  category: 'code' | 'test';
  kind: 'changed' | 'boundary';
  module: string | null;
}

/** A project/module box the change touched (subset of the change graph). */
export interface DiscoveryProject {
  id: string;
  name: string;
  path: string | null;
}

/** Everything the pure discovery engine needs — all drawn from the PR review. */
export interface DiscoveryInput {
  description: string | null;
  changedFiles: number;
  projects: DiscoveryProject[];
  nodes: DiscoveryNode[];
}

/** One turn in the review-agent conversation. */
export interface ReviewBoardChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** The agent's answer to a chat turn. */
export interface ReviewBoardChatReply {
  answer: string;
}

/** The AI's per-perspective verdict: findings, or an explicit skip + reason. */
export interface PerspectiveAnalysis {
  perspectiveId: string;
  /** The fully rolled-up perspective (deterministic + AI findings merged). */
  perspective: ReviewPerspective;
  /** True when the AI judged this perspective not applicable to the change. */
  skipped: boolean;
  /** Plain-language reason the perspective was skipped, or null. */
  skipReason: string | null;
}

/** Application service backing the Project Review Board page. */
export interface ReviewBoardService {
  /** The board for a review feature, or throws when no review exists. */
  get(featureId: string): ReviewBoard;
  /**
   * Run the AI reviewer over the change and return the board enriched with
   * evidence-backed, per-perspective findings merged on top of the
   * deterministic ones. Throws when no PR review exists.
   */
  analyze(featureId: string): Promise<ReviewBoard>;
  /**
   * Run the AI reviewer over a *single* perspective and return its rolled-up
   * result. Lets the UI analyse perspectives independently and show live,
   * per-perspective progress. Throws when no PR review exists or the
   * perspective id is not on the board.
   */
  analyzePerspective(
    featureId: string,
    perspectiveId: string,
  ): Promise<PerspectiveAnalysis>;
  /**
   * Ask the context-aware review agent a question. `perspectiveId` scopes the
   * conversation to one lens (or is null for the whole board). Throws when no
   * PR review exists.
   */
  chat(
    featureId: string,
    perspectiveId: string | null,
    messages: ReviewBoardChatMessage[],
  ): Promise<ReviewBoardChatReply>;
}
