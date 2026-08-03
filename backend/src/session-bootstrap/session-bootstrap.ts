import type { FeatureService } from '../feature/feature-service.js';
import { ConflictError, NotFoundError } from '../kernel/error-types.js';
import type { RepositoryContextConfig } from '../repository-context/config.js';
import type { RepositoryContextCoordinator } from '../repository-context/repository-context-coordinator.js';
import type { Session } from '../session/session-contract.js';
import type { SessionRepo } from '../session/session-repo-port.js';
import type { SessionSummaryStore } from '../session-summary/session-summary-store-port.js';
import type { SkillsService } from '../skills/skills-service.js';
import type { ContextService } from '../context-store/context-service.js';

export interface SessionBootstrapDeps {
  features: Pick<FeatureService, 'get'>;
  sessions: Pick<SessionRepo, 'get' | 'listByFeature'>;
  summaries: Pick<SessionSummaryStore, 'load'>;
  skills: Pick<
    SkillsService,
    'instructionsForFeature' | 'instructionsForSession'
  >;
  contexts: Pick<RepositoryContextCoordinator, 'ensureFresh'>;
  sharedContext: Pick<ContextService, 'composeLayered'>;
  config: RepositoryContextConfig;
}

export interface SessionBootstrap {
  assertFeatureReady(featureId: string): Promise<void>;
  composeForSession(session: Session): Promise<string>;
}

const section = (heading: string, content: string): string =>
  `## ${heading}\n\n${content}`;

async function repositoryContext(
  deps: SessionBootstrapDeps,
  featureId: string,
): Promise<string | null> {
  const feature = deps.features.get(featureId);
  if (!feature.repoId) {
    return null;
  }

  let context;
  try {
    context = await deps.contexts.ensureFresh(feature.repoId);
  } catch (error) {
    if (error instanceof NotFoundError) {
      throw new ConflictError(
        `Repository context is not ready for feature ${featureId}: pending`,
      );
    }
    throw error;
  }
  if (context.status !== 'ready' || !context.content?.trim()) {
    throw new ConflictError(
      `Repository context is not ready for feature ${featureId}: ${context.status}`,
    );
  }
  return context.content.slice(0, deps.config.maxOutputChars);
}

function priorSessionMemory(
  deps: SessionBootstrapDeps,
  current: Session,
): string {
  const candidates = deps.sessions
    .listByFeature(current.featureId)
    .filter(
      (session) =>
        session.id !== current.id &&
        session.kind === 'dev' &&
        session.scope !== 'internal' &&
        session.status === 'completed',
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const blocks: string[] = [];
  let remaining = deps.config.maxFeatureMemoryChars;
  for (const session of candidates) {
    if (blocks.length >= deps.config.maxFeatureMemoryItems || remaining === 0) {
      break;
    }
    const summary = deps.summaries.load(session.id)?.content.trim() ?? '';
    if (!summary) {
      continue;
    }
    const bounded = summary.slice(0, remaining);
    blocks.push(
      `### Session ${session.id} (${session.createdAt})\n\n${bounded}`,
    );
    remaining -= bounded.length;
  }
  return blocks.join('\n\n');
}

/** Builds fresh, provider-neutral development context immediately before launch. */
export function createSessionBootstrap(
  deps: SessionBootstrapDeps,
): SessionBootstrap {
  return {
    async assertFeatureReady(featureId) {
      await repositoryContext(deps, featureId);
    },
    async composeForSession(session) {
      if (session.kind !== 'dev' || session.scope === 'internal') {
        return '';
      }

      const feature = deps.features.get(session.featureId);
      const context = await repositoryContext(deps, session.featureId);
      const shared = deps.sharedContext.composeLayered({
        repoId: feature.repoId,
        featureId: session.featureId,
      });
      const memory = priorSessionMemory(deps, session);
      const skills = deps.sessions.get(session.id)
        ? deps.skills.instructionsForSession(session.id)
        : deps.skills.instructionsForFeature(session.featureId);

      const sections = [
        context ? section('Repository Context', context) : '',
        shared,
        section(
          'Feature',
          `Name: ${feature.name}\n\nDescription:\n${feature.description}`,
        ),
        memory ? section('Prior Completed Development Sessions', memory) : '',
        skills ? section('Effective Skill Instructions', skills) : '',
      ].filter((value) => value.length > 0);

      return `# Session Bootstrap Context\n\n${sections.join('\n\n')}`;
    },
  };
}

/** Keeps persisted user prompts separate from launch-only bootstrap context. */
export function composeBootstrappedPrompt(
  bootstrap: string,
  userPrompt: string,
): string {
  if (!bootstrap) {
    return userPrompt;
  }
  return `${bootstrap}\n\n## User Request\n\n${userPrompt}`;
}
