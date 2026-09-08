import type { MetaRunner } from '../meta/meta-runner.js';
import type { AiInvoker } from './automation-ports.js';

/** Adapts the shared meta runner to the automation subsystem's AI port. */
export function createAutomationAiInvoker(meta: MetaRunner): AiInvoker {
  return {
    run(input) {
      return meta.runDetailed({
        automationId: input.automationId ?? undefined,
        originSessionId: input.originSessionId ?? undefined,
        featureId: input.featureId,
        providerId: input.providerId,
        model: input.model,
        prompt: input.prompt,
        attachments: input.attachments,
        cwd: input.cwd,
        noTools: input.noTools,
        timeoutMs: input.timeoutMs,
        scope: input.scope ?? 'internal',
        purpose: input.purpose,
        label: input.label,
        signal: input.signal,
        onStart: input.onStart,
        onActivity: input.onActivity,
      });
    },
  };
}
