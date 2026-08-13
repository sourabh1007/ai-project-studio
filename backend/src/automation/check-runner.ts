import type {
  CheckResult,
  CheckRunner,
  CheckSpec,
  RunContext,
} from './automation-contract.js';
import type {
  AiInvoker,
  CiPipelineProbe,
  HttpProbe,
  ShellExecutor,
} from './automation-ports.js';

export interface CheckRunnerDeps {
  shell: ShellExecutor;
  http: HttpProbe;
  ai: AiInvoker;
  ci: CiPipelineProbe;
}

/** Usage-attribution partition for an AI check/action of an automation. */
export function attributionFeatureId(ctx: RunContext): string {
  return ctx.origin.featureId ?? `automation:${ctx.automationId}`;
}

/** True when free-form AI text reads as an affirmative verdict. */
export function isAffirmative(text: string): boolean {
  return /\byes\b|\btrue\b|\bdone\b|\bcomplete/i.test(text);
}

/**
 * Runs a monitor's {@link CheckSpec} and normalizes it into a
 * {@link CheckResult}. Dispatches to the injected IO ports; all mapping logic is
 * pure and branch-tested.
 */
export function createCheckRunner(deps: CheckRunnerDeps): CheckRunner {
  const runShell = async (
    command: string,
    cwd: string | undefined,
  ): Promise<CheckResult> => {
    const { code, stdout, stderr } = await deps.shell.exec(command, cwd);
    const text = `${stdout}${stderr}`.trim();
    return {
      code,
      status: String(code),
      conclusion: null,
      text,
      occurrenceKey: null,
    };
  };

  const runHttp = async (
    url: string,
    method: 'GET' | 'POST',
  ): Promise<CheckResult> => {
    const { status, body } = await deps.http.fetch(url, method);
    return {
      code: status,
      status: String(status),
      conclusion: null,
      text: body.trim(),
      occurrenceKey: null,
    };
  };

  const runAi = async (
    prompt: string,
    cwd: string | undefined,
    ctx: RunContext,
  ): Promise<CheckResult> => {
    const { text } = await deps.ai.run({
      featureId: attributionFeatureId(ctx),
      prompt: `${prompt}\n\nAnswer strictly with "yes" or "no" on the first line.`,
      cwd,
    });
    const verdict = isAffirmative(text) ? 1 : 0;
    return {
      code: verdict,
      status: verdict === 1 ? 'yes' : 'no',
      conclusion: null,
      text: text.trim(),
      occurrenceKey: null,
    };
  };

  const runCi = async (spec: CheckSpec & { type: 'ci-pipeline' }): Promise<CheckResult> => {
    const run = await deps.ci.latestRun(spec);
    if (!run) {
      return {
        code: null,
        status: 'none',
        conclusion: null,
        text: 'No pipeline run found',
        occurrenceKey: null,
      };
    }
    return {
      code: null,
      status: run.status,
      conclusion: run.conclusion,
      text: `${run.status}${run.conclusion ? `/${run.conclusion}` : ''}`,
      occurrenceKey: run.id,
    };
  };

  return {
    run(spec, ctx) {
      switch (spec.type) {
        case 'shell':
          return runShell(spec.command, spec.cwd);
        case 'http':
          return runHttp(spec.url, spec.method ?? 'GET');
        case 'ai':
          return runAi(spec.prompt, spec.cwd, ctx);
        case 'ci-pipeline':
          return runCi(spec);
      }
    },
  };
}
