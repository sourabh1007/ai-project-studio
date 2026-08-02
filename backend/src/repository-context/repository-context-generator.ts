import type { RepositoryContextConfig } from './config.js';
import {
  buildRepositoryAnalysisPrompt,
  buildRepositoryChunkPrompt,
  buildRepositorySynthesisPrompt,
  normalizeRepositoryContext,
} from './prompt-builder.js';
import type {
  RepositoryEvidence,
  RepositoryEvidenceFile,
} from './repository-context-contract.js';
import type {
  RepositoryAnalysisExecutor,
  RepositoryContextGenerator,
} from './repository-context-generator-port.js';

interface EvidenceChunk {
  label: string;
  tree: string;
  files: RepositoryEvidenceFile[];
}

function topLevel(path: string): string {
  const separator = path.indexOf('/');
  return separator < 0 ? 'root' : path.slice(0, separator);
}

export function groupRepositoryEvidence(
  evidence: RepositoryEvidence,
  config: RepositoryContextConfig,
): EvidenceChunk[] {
  const groups = new Map<string, RepositoryEvidenceFile[]>();
  for (const file of evidence.files) {
    const label = topLevel(file.path);
    const files = groups.get(label) ?? [];
    files.push(file);
    groups.set(label, files);
  }

  return [...groups.entries()]
    .sort(([left], [right]) =>
      left.replace(/^root$/, '\0').localeCompare(
        right.replace(/^root$/, '\0'),
      ),
    )
    .slice(0, config.maxChunks)
    .map(([label, files]) => {
      const tree = evidence.tree
        .split('\n')
        .filter((path) =>
          label === 'root' ? !path.includes('/') : topLevel(path) === label,
        )
        .join('\n')
        .slice(0, Math.floor(config.maxChunkChars / 4));
      let remaining = config.maxChunkChars - tree.length;
      const bounded: RepositoryEvidenceFile[] = [];
      for (const file of files) {
        if (remaining === 0) break;
        const content = file.content.slice(0, remaining);
        if (content.length > 0) {
          bounded.push({ path: file.path, content });
          remaining -= content.length;
        }
      }
      return { label, tree, files: bounded };
    })
    .filter((chunk) => chunk.tree.length > 0 || chunk.files.length > 0);
}

function chunkEvidence(
  evidence: RepositoryEvidence,
  chunk: EvidenceChunk,
): RepositoryEvidence {
  return {
    ...evidence,
    tree: chunk.tree,
    files: chunk.files,
    totalFileCount: chunk.files.length,
    omittedFileCount: 0,
    totalContentChars: chunk.files.reduce(
      (total, file) => total + file.content.length,
      0,
    ),
  };
}

export function createRepositoryContextGenerator(deps: {
  executor: RepositoryAnalysisExecutor;
  config: RepositoryContextConfig;
}): RepositoryContextGenerator {
  const execute = async (
    repositoryId: string,
    repositoryPath: string,
    prompt: string,
  ): Promise<string> => {
    const content = await deps.executor.execute({
      repositoryId,
      repositoryPath,
      prompt,
      maxOutputChars: deps.config.maxOutputChars,
    });
    const normalized = normalizeRepositoryContext(content, deps.config);
    if (normalized.length === 0) {
      throw new Error('Repository analysis returned no content');
    }
    return normalized;
  };

  return {
    async generate(request, onProgress) {
      const report = (detail: string): void => onProgress?.(detail);
      if (!request.evidence.largeRepository) {
        report('Analyzing repository evidence');
        return {
          content: await execute(
            request.repositoryId,
            request.repositoryPath,
            buildRepositoryAnalysisPrompt(request.evidence, deps.config),
          ),
        };
      }

      const chunks = groupRepositoryEvidence(request.evidence, deps.config);
      if (chunks.length === 0) {
        throw new Error('Large repository has no analyzable evidence');
      }
      const summaries: string[] = [];
      for (const [position, chunk] of chunks.entries()) {
        report(
          `Summarizing section ${position + 1} of ${chunks.length}: ${chunk.label}`,
        );
        try {
          summaries.push(
            await execute(
              request.repositoryId,
              request.repositoryPath,
              buildRepositoryChunkPrompt(
                chunk.label,
                chunkEvidence(request.evidence, chunk),
                deps.config,
              ),
            ),
          );
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(`Section "${chunk.label}" analysis failed: ${detail}`);
        }
      }
      report(`Synthesizing ${chunks.length} sections`);
      return {
        content: await execute(
          request.repositoryId,
          request.repositoryPath,
          buildRepositorySynthesisPrompt(summaries, deps.config),
        ),
      };
    },
  };
}
