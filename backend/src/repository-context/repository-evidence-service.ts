import type { RepositoryContextConfig } from './config.js';
import { buildRepositoryEvidence } from './evidence-builder.js';
import type { RepositoryEvidenceCollector } from './repository-evidence-port.js';
import type { RepositoryEvidence } from './repository-context-contract.js';
import type { RepositoryRevisionLookup } from './repository-revision-port.js';

export function createRepositoryEvidenceService(deps: {
  revisionLookup: RepositoryRevisionLookup;
  collector: RepositoryEvidenceCollector;
  config: RepositoryContextConfig;
}): { collect(repositoryPath: string): Promise<RepositoryEvidence> } {
  return {
    async collect(repositoryPath) {
      const [sourceRevision, collected] = await Promise.all([
        deps.revisionLookup.getRevision(repositoryPath),
        deps.collector.collect({
          repositoryPath,
          prioritizedFiles: deps.config.prioritizedFiles,
          ignoredDirectories: deps.config.ignoredDirectories,
          maxFileBytes: deps.config.maxFileBytes,
          maxFileChars: deps.config.maxFileChars,
          maxTreeChars: deps.config.maxTreeChars,
          maxContentChars: deps.config.maxContentChars,
          maxEvidenceFiles: deps.config.maxEvidenceFiles,
        }),
      ]);
      return buildRepositoryEvidence(
        sourceRevision,
        collected.tree,
        collected.files,
        deps.config,
        collected.totalTrackedFileCount,
      );
    },
  };
}
