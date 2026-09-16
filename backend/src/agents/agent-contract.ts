/**
 * The Agent platform contract.
 *
 * An *agent* is an isolated, attachable analysis surface (the Review Board is
 * the first) that a user attaches to a feature. Agents are contributed to a
 * registry as {@link AgentDefinition}s and never hand-wired into the core: the
 * host owns attachment persistence, prerequisite gating, usage roll-up and the
 * management view generically. See `docs/agents.md` for the full design.
 *
 * Nothing here is tied to the Review Board specifically — it is the generic
 * shape every agent conforms to.
 */

/** One editable prompt/setting an agent exposes, backed by a config field. */
export interface AgentPromptField {
  /** Config namespace the field lives in (e.g. `reviewBoard`). */
  namespace: string;
  /** Config key within the namespace (e.g. `perspectivePromptTemplate`). */
  key: string;
  /** Human label shown in the Agents management view. */
  label: string;
  /** One-line explanation of what this prompt/setting drives. */
  description: string;
  /** Placeholders the template supports, shown as editing hints. */
  placeholders?: string[];
}

/**
 * The static identity and rules of an agent. `id` doubles as the stable key
 * used in routes (`/agents/:id`), attachments and the UI registry.
 */
export interface AgentManifest {
  /** Stable agent id, e.g. `review-board`. */
  id: string;
  /** Human title, e.g. `Review Board`. */
  title: string;
  /** One-line description shown in the Agents view. */
  description: string;
  /** Registered UI icon id the shell renders for this agent. */
  icon: string;
  /** Whether the same agent may be attached to one feature more than once. */
  allowMultiplePerFeature: boolean;
  /** Human-readable statement of what a feature must have to attach this. */
  prerequisiteLabel: string;
  /**
   * The `meta_operations.label` every one of this agent's AI runs is recorded
   * under, so the host can roll up its total credits and run count to show an
   * average. Agents must tag their `MetaRunner` calls with this exact label.
   */
  usageLabel: string;
  /** The editable prompts/settings surfaced in the Agents management view. */
  promptFields: AgentPromptField[];
}

/** The result of checking whether an agent may attach to a feature. */
export interface AgentPrerequisiteResult {
  met: boolean;
  /** Why the prerequisite is unmet, for the UI to explain the block. */
  reason?: string;
}

/**
 * A complete agent contributed to the registry: its manifest plus a
 * prerequisite predicate the composition root wires with whatever read-ports
 * the check needs (e.g. the PR-review lookup for the Review Board).
 */
export interface AgentDefinition {
  manifest: AgentManifest;
  /** Whether the agent can attach to this feature, and why not when it can't. */
  checkPrerequisite(featureId: string): AgentPrerequisiteResult;
}

/** A persisted link attaching an agent to a feature. */
export interface AgentAttachment {
  id: string;
  agentId: string;
  featureId: string;
  createdAt: string;
}

/** Rolled-up usage for a single agent across all of its runs. */
export interface AgentUsageSummary {
  /** Total credits consumed across every recorded run, or null when unknown. */
  totalCredits: number | null;
  /** Number of recorded runs the total is spread across. */
  runs: number;
  /** `totalCredits / runs`, or null when there is nothing to average. */
  averageCredits: number | null;
}

/** A catalog entry in the Agents management view: manifest + usage + reach. */
export interface AgentCatalogItem {
  manifest: AgentManifest;
  usage: AgentUsageSummary;
  /** How many features currently have this agent attached. */
  attachmentCount: number;
}

/** An attached agent enriched with its manifest, for rendering on a feature. */
export interface AttachedAgent {
  attachment: AgentAttachment;
  manifest: AgentManifest;
}

/** An agent offered for attachment to a feature, with its eligibility. */
export interface AvailableAgent {
  manifest: AgentManifest;
  /** True when the agent can currently be attached to the feature. */
  attachable: boolean;
  /** Why it cannot be attached (prerequisite unmet, or already attached). */
  reason?: string;
}
