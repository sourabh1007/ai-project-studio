import type { CreateSkillInput, Skill } from './skills-contract.js';

const common = 'Identify the actual Cosmos DB API, SDK or native subsystem from captured evidence; do not transfer NoSQL guarantees to other APIs. Use pinned repository contracts, not guessed internal policy. Report only changed behavior: 1-2 short sentences and a small evidence-grounded ASCII flow when useful. Never claim tools or tests ran without execution evidence.';

const topics = [
  {
    name: 'Evidence and repository tooling',
    match: /./s,
    guidance: 'Follow applicable baseline AGENTS/instructions and repository skills. Reuse documented test helpers, build targets and diagnostics as verification references; do not run commands, install tools or access production. Cite exact supplied skill IDs only when a rule supports the result. Name missing evidence once, not once per lens.',
    source: 'https://learn.microsoft.com/en-us/azure/cosmos-db/',
  },
  {
    name: 'Authentication and trust boundaries',
    match: /auth|credential|permission|rbac|identity|resource.?token|system.?flag|marker/i,
    guidance: 'Trace caller identity -> authentication -> authorization -> store work. A client-controlled header or background marker is not proof of system identity. Check both allowed and denied callers, default/missing flags, scope and error precedence. Separate control-plane permissions from data-plane permissions.',
    source: 'https://learn.microsoft.com/en-us/azure/cosmos-db/how-to-connect-role-based-access-control',
  },
  {
    name: 'HTTP and RNTBD protocol compatibility',
    match: /rntbd|protocol|header|serialization|deserial|transport|gateway|http|request.?parser/i,
    guidance: 'Trace each changed request field through captured HTTP/gateway and direct/RNTBD parsers, defaults, validation and dispatch. Check old-client/new-service and new-client/old-service behavior, malformed input and error precedence. If a parser is not captured, say so; do not infer parity from one handler.',
    source: 'https://learn.microsoft.com/en-us/azure/cosmos-db/sdk-connection-modes',
  },
  {
    name: 'Partition routing and migration',
    match: /partition|routing|split|merge|range|migration|shard/i,
    guidance: 'Check partition-key identity, routing refresh and split/merge handling. Trace stale range maps, concurrent migration, ownership and retries without lost or duplicate writes. For NoSQL multi-item transactions, verify the logical-partition scope; do not assume cross-partition atomicity.',
    source: 'https://learn.microsoft.com/en-us/azure/cosmos-db/partitioning',
  },
  {
    name: 'Transactions and optimistic concurrency',
    match: /transaction|etag|if.?match|batch|snapshot|commit|rollback|concurren/i,
    guidance: 'Trace read/version -> conditional write -> commit or conflict. Verify ETag/If-Match handling, transaction boundaries, partial failure and retry idempotency. For NoSQL, distinguish single-item operations from multi-item transactions within one logical partition; use captured native contracts for engine internals.',
    source: 'https://learn.microsoft.com/en-us/azure/cosmos-db/database-transactions-optimistic-concurrency',
  },
  {
    name: 'Consistency and replication',
    match: /consisten|session.?token|replica|quorum|lsn|staleness/i,
    guidance: 'Trace the requested consistency level and session token through routing, reads and failover. Check stale reads, token propagation and replica/LSN assumptions against the actual API and account settings. A successful write is not proof that every replica or independent client immediately observes it.',
    source: 'https://learn.microsoft.com/en-us/azure/cosmos-db/consistency-levels',
  },
  {
    name: 'RU throttling and bounded retries',
    match: /retr(?:y|ies)|throttl|request.?unit|budget|charge|429|timeout|cancel|backoff/i,
    guidance: 'Check RU charging, 429 retry-after handling, SDK retry interaction, deadlines, cancellation and idempotency. Distinguish throttling from authorization, conflict and ambiguous write completion. Do not recommend unbounded retries or claim timeout proves a write failed.',
    source: 'https://learn.microsoft.com/en-us/azure/cosmos-db/troubleshoot-request-rate-too-large',
  },
  {
    name: 'Multi-region failover and conflicts',
    match: /region|failover|conflict|multi.?master|multi.?write|availability/i,
    guidance: 'Trace region choice -> failure -> recovery and any changed write-conflict policy. Check ownership, duplicate work, stale reads, replay and data preservation. Verify the configured API and write topology before applying last-writer-wins or custom conflict assumptions.',
    source: 'https://learn.microsoft.com/en-us/azure/cosmos-db/conflict-resolution-policies',
  },
  {
    name: 'Query and indexing efficiency',
    match: /query|index|scan|predicate|continuation|pagination|composite/i,
    guidance: 'Check predicate/index alignment, partition fan-out, continuation tokens and changed result semantics. Distinguish missing indexes from query-plan or cardinality changes. Ask for captured query metrics/RU evidence before claiming an improvement; check index transformation and rollback compatibility.',
    source: 'https://learn.microsoft.com/en-us/azure/cosmos-db/index-overview',
  },
  {
    name: 'Change feed and checkpoint recovery',
    match: /change.?feed|checkpoint|lease|consumer|feed.?range/i,
    guidance: 'Trace lease -> read -> process -> checkpoint. Check replay idempotency, lease ownership, cancellation and split recovery. Verify the actual feed mode and API: do not assume latest-version feed includes deletes, every intermediate version or global ordering.',
    source: 'https://learn.microsoft.com/en-us/azure/cosmos-db/change-feed',
  },
  {
    name: 'Background operations and internal markers',
    match: /background|materialized|mv.?build|marker|system.?operation|builder|maintenance/i,
    guidance: 'For captured background builders/maintenance, trace marker origin -> authorized identity -> budget checks -> side effects. Check ordinary unmarked requests, system callers and combined flags; preserve documented rejection order. Do not invent materialized-view API support or infer privileges from a marker name.',
    source: 'https://learn.microsoft.com/en-us/azure/cosmos-db/how-to-connect-role-based-access-control',
  },
  {
    name: 'Native lifetime and asynchronous ownership',
    match: /\.cpp\b|\.h\b|native\/|lock|mutex|lifetime|callback|reference.?count/i,
    guidance: 'Trace ownership across callbacks, cancellation, locks and store dispatch using captured native code. Check use-after-free, double completion, lock order and cleanup on every error path. Identify the exact lifetime invariant; do not invent framework-specific guarantees or claim a test proved uncaptured execution order.',
    source: 'https://learn.microsoft.com/en-us/azure/cosmos-db/',
  },
  {
    name: 'Schema, configuration and rolling upgrades',
    match: /schema|config|feature.?flag|version|upgrade|deploy|rollout|compatib/i,
    guidance: 'Check old/new readers and writers, flag defaults, mixed-version nodes and rollback data compatibility. Separate repository deployment policy from implementation intent. Name only the changed incompatible field, state or default and the exact migration/guard needed.',
    source: 'https://learn.microsoft.com/en-us/azure/cosmos-db/',
  },
  {
    name: 'Regression tests and operational diagnostics',
    match: /test|assert|trace|metric|diagnostic|telemetry|logging/i,
    guidance: 'Reuse supplied repository test fixtures and documented targets as references. Check allowed/denied callers, both-flags precedence, protocol parity, retry/cancellation and unchanged ordinary behavior only where relevant. Separate visible test assertions from actual execution; require measured diagnostics for performance or resource claims.',
    source: 'https://learn.microsoft.com/en-us/azure/cosmos-db/troubleshoot-dotnet-sdk',
  },
] as const;

export const COSMOS_REVIEW_SKILLS: readonly CreateSkillInput[] = topics.map((topic) => ({
  name: `Cosmos DB: ${topic.name}`, kind: 'instruction', recommendedScope: 'feature',
  instructions: `${common}\n\n${topic.guidance}\n\nReference (background, not repository policy): ${topic.source}`,
}));

export function selectCosmosReviewSkillIds(input: {
  repository: string;
  description: string;
  nodes: readonly { kind: string; path: string; diff: string }[];
  skills: readonly Skill[];
  maxFiles: number;
  maxChars: number;
}): string[] {
  let evidence = input.description.slice(0, input.maxChars);
  for (const node of input.nodes.slice(0, input.maxFiles)) {
    if (node.kind !== 'changed') continue;
    evidence += `\n${node.path}\n${node.diff}`.slice(0, Math.max(0, input.maxChars - evidence.length));
    if (evidence.length >= input.maxChars) break;
  }
  if (!/cosmos(?:[\s._-]*db|client)|microsoft\.azure\.documents/i.test(`${input.repository}\n${evidence}`)) return [];
  const names = new Set(topics.filter((topic) => topic.match.test(evidence)).map((topic) => `Cosmos DB: ${topic.name}`));
  names.add(COSMOS_REVIEW_SKILLS[0]!.name);
  return input.skills.filter((skill) => skill.kind === 'instruction' && names.has(skill.name)).map((skill) => skill.id);
}
