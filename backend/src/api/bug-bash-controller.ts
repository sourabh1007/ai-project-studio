import { ValidationError } from '../kernel/error-types.js';
import type { BugBashService } from '../bug-bash/bug-bash-contract.js';
import type { Route } from './http-contract.js';

export interface BugBashControllerDeps {
  bugBash: BugBashService;
}

/** Validate and extract the `{ featureInfo, setupInfo, otherInfo }` of an inputs request. */
function assertInputs(body: unknown): {
  featureInfo: string;
  setupInfo: string;
  otherInfo: string;
} {
  const featureInfo = (body as { featureInfo?: unknown })?.featureInfo;
  if (typeof featureInfo !== 'string' || featureInfo.trim().length === 0) {
    throw new ValidationError('A non-empty "featureInfo" is required.');
  }
  const rawSetup = (body as { setupInfo?: unknown })?.setupInfo;
  if (rawSetup !== undefined && typeof rawSetup !== 'string') {
    throw new ValidationError('"setupInfo" must be a string when provided.');
  }
  const rawOther = (body as { otherInfo?: unknown })?.otherInfo;
  if (rawOther !== undefined && typeof rawOther !== 'string') {
    throw new ValidationError('"otherInfo" must be a string when provided.');
  }
  return {
    featureInfo,
    setupInfo: typeof rawSetup === 'string' ? rawSetup : '',
    otherInfo: typeof rawOther === 'string' ? rawOther : '',
  };
}

/** Validate the `{ answers: [{ id, answer }] }` of a prerequisite-answers request. */
function assertAnswers(body: unknown): { id: string; answer: string }[] {
  const rawAnswers = (body as { answers?: unknown })?.answers;
  if (!Array.isArray(rawAnswers)) {
    throw new ValidationError('An "answers" array is required.');
  }
  return rawAnswers.map((entry) => {
    const id = (entry as { id?: unknown })?.id;
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new ValidationError('Each answer requires a non-empty "id".');
    }
    const answer = (entry as { answer?: unknown })?.answer;
    if (answer !== undefined && typeof answer !== 'string') {
      throw new ValidationError('"answer" must be a string when provided.');
    }
    return { id, answer: typeof answer === 'string' ? answer : '' };
  });
}

/**
 * Routes for the Bug Bash agent: read the current run and capture the feature +
 * setup information. Generating scenarios and running them are long-lived
 * streaming operations mounted separately (each streams NDJSON progress over one
 * request), so they are not plain request/response routes.
 */
export function createBugBashRoutes(deps: BugBashControllerDeps): Route[] {
  return [
    {
      method: 'get',
      path: '/features/:featureId/bug-bash/:attachmentId',
      handler: (req) => ({
        status: 200,
        body: { run: deps.bugBash.get(req.params.attachmentId) },
      }),
    },
    {
      method: 'post',
      path: '/features/:featureId/bug-bash/:attachmentId/inputs',
      handler: (req) => {
        const { featureInfo, setupInfo, otherInfo } = assertInputs(req.body);
        return {
          status: 200,
          body: deps.bugBash.saveInputs(
            req.params.attachmentId,
            req.params.featureId,
            { featureInfo, setupInfo, otherInfo },
          ),
        };
      },
    },
    {
      method: 'post',
      path: '/features/:featureId/bug-bash/:attachmentId/prerequisites',
      handler: async (req) => ({
        status: 200,
        body: await deps.bugBash.generatePrerequisites(req.params.attachmentId),
      }),
    },
    {
      method: 'post',
      path: '/features/:featureId/bug-bash/:attachmentId/prerequisites/answers',
      handler: (req) => ({
        status: 200,
        body: deps.bugBash.savePrerequisiteAnswers(
          req.params.attachmentId,
          assertAnswers(req.body),
        ),
      }),
    },
  ];
}
