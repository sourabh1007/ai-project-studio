import type { Clock } from '../kernel/clock.js';
import { ConflictError, NotFoundError } from '../kernel/error-types.js';
import type {
  AgentAttachment,
  AgentCatalogItem,
  AgentDefinition,
  AgentUsageSummary,
  AttachedAgent,
  AvailableAgent,
} from './agent-contract.js';
import type { AgentAttachmentRepo } from './agent-attachment-repo-port.js';
import type { AgentRegistry } from './agent-registry.js';
import type { AgentUsageReader } from './agent-usage-reader-port.js';

/** Dependencies for {@link createAgentService}. */
export interface AgentServiceDeps {
  registry: AgentRegistry;
  attachments: AgentAttachmentRepo;
  usage: AgentUsageReader;
  clock: Pick<Clock, 'isoNow'>;
  newId: () => string;
}

/**
 * Application service backing the Agent platform: the management catalog, the
 * per-feature attach/detach flow (with prerequisite + multiplicity gating) and
 * the auto-attach/backfill used to keep the Review Board present on PR-review
 * features exactly as before.
 */
export interface AgentService {
  /** Every installed agent with its rolled-up usage and reach. */
  listCatalog(): AgentCatalogItem[];
  /** One installed agent's catalog entry, or throws when unknown. */
  getCatalogItem(agentId: string): AgentCatalogItem;
  /** Agents currently attached to a feature, in creation order. */
  attachedAgents(featureId: string): AttachedAgent[];
  /** Every installed agent with whether it can attach to this feature. */
  availableAgents(featureId: string): AvailableAgent[];
  /** Attach an agent to a feature, enforcing prerequisite + multiplicity. */
  attach(featureId: string, agentId: string): AgentAttachment;
  /** Detach a single attachment, or throws when unknown. */
  detach(attachmentId: string): void;
  /** Remove every attachment on a feature (feature-deletion cleanup). */
  removeFeature(featureId: string): void;
  /**
   * Attach an agent to a feature if — and only if — it is eligible and not yet
   * attached. Silent: used by event hooks (PR import) where a duplicate or an
   * unmet prerequisite is simply a no-op rather than an error.
   */
  autoAttach(featureId: string, agentId: string): void;
  /**
   * One-shot: auto-attach `agentId` to every eligible feature in `featureIds`
   * that is not already attached, then mark the backfill done so a later detach
   * is never undone. Re-running is a no-op once marked.
   */
  backfillAutoAttachments(agentId: string, featureIds: readonly string[]): void;
}

function usageSummary(
  usage: AgentUsageReader,
  usageLabel: string,
): AgentUsageSummary {
  const { credits, runs } = usage.aggregateByLabel(usageLabel);
  const averageCredits =
    runs > 0 && credits !== null ? credits / runs : null;
  return { totalCredits: credits, runs, averageCredits };
}

export function createAgentService(deps: AgentServiceDeps): AgentService {
  function requireDefinition(agentId: string): AgentDefinition {
    const definition = deps.registry.get(agentId);
    if (!definition) {
      throw new NotFoundError(`Unknown agent: ${agentId}`);
    }
    return definition;
  }

  function catalogItem(definition: AgentDefinition): AgentCatalogItem {
    const { manifest } = definition;
    const attachmentCount = deps.attachments
      .listAll()
      .filter((attachment) => attachment.agentId === manifest.id).length;
    return {
      manifest,
      usage: usageSummary(deps.usage, manifest.usageLabel),
      attachmentCount,
    };
  }

  /** Why the agent cannot attach right now, or null when it can. */
  function attachBlock(
    definition: AgentDefinition,
    featureId: string,
  ): string | null {
    const { manifest } = definition;
    if (
      !manifest.allowMultiplePerFeature &&
      deps.attachments.countByAgentAndFeature(manifest.id, featureId) > 0
    ) {
      return `${manifest.title} is already attached to this feature.`;
    }
    const prerequisite = definition.checkPrerequisite(featureId);
    if (!prerequisite.met) {
      return prerequisite.reason ?? `Requires ${manifest.prerequisiteLabel}.`;
    }
    return null;
  }

  function createAttachment(agentId: string, featureId: string): AgentAttachment {
    const attachment: AgentAttachment = {
      id: deps.newId(),
      agentId,
      featureId,
      createdAt: deps.clock.isoNow(),
    };
    deps.attachments.create(attachment);
    return attachment;
  }

  return {
    listCatalog() {
      return deps.registry.list().map(catalogItem);
    },

    getCatalogItem(agentId) {
      return catalogItem(requireDefinition(agentId));
    },

    attachedAgents(featureId) {
      return deps.attachments
        .listByFeature(featureId)
        .map((attachment) => {
          const definition = deps.registry.get(attachment.agentId);
          return definition
            ? { attachment, manifest: definition.manifest }
            : null;
        })
        .filter((entry): entry is AttachedAgent => entry !== null);
    },

    availableAgents(featureId) {
      return deps.registry.list().map((definition) => {
        const reason = attachBlock(definition, featureId);
        return {
          manifest: definition.manifest,
          attachable: reason === null,
          ...(reason === null ? {} : { reason }),
        };
      });
    },

    attach(featureId, agentId) {
      const definition = requireDefinition(agentId);
      const reason = attachBlock(definition, featureId);
      if (reason !== null) {
        throw new ConflictError(reason);
      }
      return createAttachment(agentId, featureId);
    },

    detach(attachmentId) {
      const existing = deps.attachments.get(attachmentId);
      if (!existing) {
        throw new NotFoundError(`Unknown attachment: ${attachmentId}`);
      }
      deps.attachments.delete(attachmentId);
    },

    removeFeature(featureId) {
      deps.attachments.deleteByFeature(featureId);
    },

    autoAttach(featureId, agentId) {
      const definition = deps.registry.get(agentId);
      if (!definition) {
        return;
      }
      if (attachBlock(definition, featureId) !== null) {
        return;
      }
      createAttachment(agentId, featureId);
    },

    backfillAutoAttachments(agentId, featureIds) {
      const key = `auto:${agentId}`;
      if (deps.attachments.isBackfilled(key)) {
        return;
      }
      const definition = deps.registry.get(agentId);
      if (definition) {
        for (const featureId of featureIds) {
          if (attachBlock(definition, featureId) === null) {
            createAttachment(agentId, featureId);
          }
        }
      }
      deps.attachments.markBackfilled(key);
    },
  };
}
