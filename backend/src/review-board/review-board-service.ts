/**
 * Application service backing the Project Review Board page.
 *
 * The board is a *derived* view over a change's existing PR review: it reuses
 * the already-computed change graph and diff as evidence, runs the pure,
 * generic discovery engine to build a `ProjectModel`, and assembles the dynamic
 * board (perspectives + deterministic findings). All heavy lifting lives in the
 * pure `project-discovery` and `review-board-builder` modules; this service is
 * thin glue that reads the review and injects config/clock.
 */

import type { Clock } from '../kernel/clock.js';
import type { PrReview } from '../pr-review/pr-review-contract.js';
import type { ReviewBoardConfig } from './config.js';
import { discoverProjectModel } from './project-discovery.js';
import { buildReviewBoard } from './review-board-builder.js';
import type {
  DiscoveryInput,
  ReviewBoard,
  ReviewBoardService,
} from './review-board-contract.js';

/** The read port over PR reviews the board derives from. */
export interface ReviewBoardReviewsPort {
  /** The review for a feature, throwing when none exists. */
  get(featureId: string): PrReview;
}

/** Dependencies for {@link createReviewBoardService}. */
export interface ReviewBoardServiceDeps {
  reviews: ReviewBoardReviewsPort;
  config: ReviewBoardConfig;
  clock: Clock;
}

/** Project the persisted PR review down to the discovery engine's inputs. */
function toDiscoveryInput(review: PrReview): DiscoveryInput {
  return {
    description: review.description,
    changedFiles: review.changedFiles ?? 0,
    projects: review.changeGraph.projects.map((p) => ({
      id: p.id,
      name: p.name,
      path: p.path,
    })),
    nodes: review.changeGraph.nodes.map((n) => ({
      path: n.path,
      category: n.category,
      kind: n.kind,
      module: n.module,
    })),
  };
}

export function createReviewBoardService(
  deps: ReviewBoardServiceDeps,
): ReviewBoardService {
  return {
    get(featureId: string): ReviewBoard {
      const review = deps.reviews.get(featureId);
      const discovery = toDiscoveryInput(review);
      const model = discoverProjectModel(discovery);
      return buildReviewBoard({
        featureId: review.featureId,
        pull: {
          number: review.pull.number,
          title: review.pull.title,
          url: review.pull.url,
        },
        worktreePath: review.worktreePath,
        baseBranch: review.baseBranch,
        description: review.description,
        nodes: discovery.nodes,
        changedFiles: discovery.changedFiles,
        model,
        thresholds: {
          minDescriptionChars: deps.config.minDescriptionChars,
          blastRadiusMediumThreshold: deps.config.blastRadiusMediumThreshold,
          blastRadiusHighThreshold: deps.config.blastRadiusHighThreshold,
        },
        generatedAt: deps.clock.isoNow(),
      });
    },
  };
}
