import { useAgentUsage } from '../hooks/use-agent-usage.js';
import type { AgentUsage } from '../lib/agent-usage.js';

export function AgentUsageValue({ usage }: {
  usage: AgentUsage & { loading?: boolean; error?: boolean; incompleteFeatures?: number };
}) {
  const measured = usage.aic === null ? 'AIC unavailable' : `${usage.aic.toLocaleString(undefined, {
    maximumFractionDigits: 3,
  })} AIC`;
  const suffix = usage.error ? ' · refresh failed'
    : usage.loading ? ' · loading'
    : usage.unknownOperations > 0 || (usage.incompleteFeatures ?? 0) > 0 ? ' · partial'
    : usage.running ? ' · so far' : '';
  return <span aria-label="Agent AI credits" title={
    `Vendor nano-AIU ÷ 1,000,000,000. ${usage.operations} attempts; ${usage.unknownOperations} awaiting usage. Includes charged retries once.`
  }>{measured}{suffix}</span>;
}

export function FeatureAgentUsage(props: {
  featureId: string; usageLabel: string; perspectiveId?: string;
}) {
  const usage = useAgentUsage(props.featureId, props.usageLabel, props.perspectiveId);
  return <AgentUsageValue usage={usage} />;
}
