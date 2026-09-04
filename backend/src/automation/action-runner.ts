import type {
  ActionResult,
  ActionRunner,
  RunContext,
} from './automation-contract.js';
import type { AiInvoker, ShellExecutor } from './automation-ports.js';
import { attributionFeatureId } from './check-runner.js';
import type { SubagentService } from './subagent-service.js';

const MAX_DETAIL_CHARS = 500;

function truncate(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_DETAIL_CHARS
    ? `${trimmed.slice(0, MAX_DETAIL_CHARS - 1)}…`
    : trimmed;
}

export interface ActionRunnerDeps {
  ai: AiInvoker;
  shell: ShellExecutor;
  subagents: SubagentService;
}

/**
 * Runs a monitor's {@link ActionRunner} action when its condition fires.
 * Metasession/report actions attribute usage to the origin feature (or a stable
 * `automation:<id>` key); subagent actions delegate to the tracked
 * {@link SubagentService}; command actions run a bounded shell command.
 */
export function createActionRunner(deps: ActionRunnerDeps): ActionRunner {
  const runAi = async (
    prompt: string,
    cwd: string | undefined,
    ctx: RunContext,
  ): Promise<{ text: string; sessionId: string }> =>
    deps.ai.run({
      featureId: attributionFeatureId(ctx),
      prompt,
      cwd,
      label: 'Automation action',
      signal: ctx.signal,
    });

  return {
    async run(spec, ctx): Promise<ActionResult> {
      switch (spec.type) {
        case 'metasession': {
          const { text, sessionId } = await runAi(spec.prompt, spec.cwd, ctx);
          return {
            detail: truncate(text) || 'Metasession completed',
            sessionId,
            subagentId: null,
            report: null,
          };
        }
        case 'report': {
          const { text, sessionId } = await runAi(spec.prompt, spec.cwd, ctx);
          return {
            detail: 'Report generated',
            sessionId,
            subagentId: null,
            report: text.trim(),
          };
        }
        case 'subagent': {
          const { subagent } = deps.subagents.spawn({
            task: spec.task,
            prompt: spec.prompt,
            origin: ctx.origin,
            automationId: ctx.automationId,
            cwd: spec.cwd,
          });
          return {
            detail: `Subagent started: ${spec.task}`,
            sessionId: null,
            subagentId: subagent.id,
            report: null,
          };
        }
        case 'command': {
          const { code, stdout, stderr } = await deps.shell.exec(
            spec.command,
            spec.cwd,
            ctx.signal,
          );
          const output = truncate(`${stdout}${stderr}`);
          return {
            detail: `Command exited ${code}${output ? `: ${output}` : ''}`,
            sessionId: null,
            subagentId: null,
            report: null,
          };
        }
      }
    },
  };
}
