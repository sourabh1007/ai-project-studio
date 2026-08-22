import type { FeatureService } from '../feature/feature-service.js';
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

/**
 * Standing policy injected into every dev session so ANY request to observe
 * something over time is captured as a real Studio monitor (and therefore shows
 * up in — and is controllable from — the Monitors panel) instead of the CLI
 * hand-rolling its own polling loop or firing a bespoke tracking skill that the
 * app can never see. This is the app's only reliable lever over model/skill
 * behaviour, so it is deliberately explicit and directive.
 */
const MONITORING_POLICY = [
  'When the user asks you to monitor, watch, track, tail, poll, or be',
  'notified/alerted when something changes or completes — a CI/CD pipeline,',
  'build or release, a pull request, a deployment, an HTTP endpoint, a file, a',
  'long-running command, or any recurring condition — you MUST register it as a',
  'Studio monitor by calling the `create_monitor` tool on the',
  '`ai-project-studio` MCP server. That is the only way the monitor appears in,',
  'and can be paused/resumed/cancelled from, the Monitors panel. Do NOT instead',
  'hand-roll your own polling loop, background shell `while` loop, `/every`',
  'schedule, or a separate tracking/monitoring skill — the Studio engine owns',
  'the polling once the monitor is registered and keeps running even after this',
  'session ends. Pick an appropriate check, condition, and action, with `mode`',
  '"short" to fire once or "long" to keep watching, call `create_monitor`',
  'exactly once for the request, then report that monitoring is registered and',
  'stop. This applies no matter how the user phrases the request.',
].join(' ');

/**
 * Resolves the repository context for a feature WITHOUT ever blocking a session
 * launch on it. Calling `ensureFresh` triggers (and keeps alive) the background
 * repository analysis, but analysis for a large repo can take a while. Rather
 * than gate the session behind it — which froze every session under a repo
 * until analysis finished — we return the summary only when it is already
 * `ready`, and otherwise return `null` so the session launches immediately
 * without the Repository Context section. A later session picks up the richer
 * context once the background analysis completes.
 */
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
  } catch {
    // Triggering/looking up analysis failed — never block the session on it;
    // background analysis will retry and a future session can pick it up.
    return null;
  }
  if (context.status !== 'ready' || !context.content?.trim()) {
    return null;
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
    // Triggers background repository analysis for the feature's repo but never
    // blocks on it — a session must be able to launch immediately even while the
    // repo is still being analyzed.
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
        section('Monitoring & Automations', MONITORING_POLICY),
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
