import type { GhRunner } from '../github-auth/github-auth-service.js';
import type { CiPipelineProbe, CiPipelineRun } from './automation-ports.js';

interface GhRunJson {
  databaseId?: number;
  status?: string;
  conclusion?: string | null;
  headBranch?: string;
}

/**
 * Real {@link CiPipelineProbe}. For GitHub it shells out to `gh run list`
 * (reusing the IDE's authenticated `gh` runner) and returns the latest workflow
 * run's normalized state. Azure DevOps pipelines are not yet supported and
 * resolve to `null` (no run found). Thin IO adapter, excluded from unit coverage.
 */
export function createCiPipelineProbe(gh: GhRunner): CiPipelineProbe {
  return {
    async latestRun(spec): Promise<CiPipelineRun | null> {
      if (spec.provider !== 'github') {
        return null;
      }
      const args = [
        'run',
        'list',
        '--repo',
        spec.repo,
        '--json',
        'databaseId,status,conclusion,headBranch',
        '--limit',
        '20',
      ];
      if (spec.pipeline) {
        args.push('--workflow', spec.pipeline);
      }
      const result = await gh(args);
      if (result.code !== 0) {
        return null;
      }
      let runs: GhRunJson[];
      try {
        runs = JSON.parse(result.stdout) as GhRunJson[];
      } catch {
        return null;
      }
      const match = runs.find(
        (run) =>
          typeof run.databaseId === 'number' &&
          (!spec.ref || run.headBranch === spec.ref),
      );
      if (!match || typeof match.databaseId !== 'number') {
        return null;
      }
      return {
        id: String(match.databaseId),
        status: match.status ?? 'unknown',
        conclusion: match.conclusion ?? null,
      };
    },
  };
}
