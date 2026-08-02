import type { RepositoryEvidence } from './repository-context-contract.js';

/** Provider-neutral request to generate text from bounded repository evidence. */
export interface RepositoryContextGenerationRequest {
  repositoryId: string;
  repositoryPath: string;
  evidence: RepositoryEvidence;
}

export interface RepositoryContextGenerationResult {
  content: string;
}

/** Runs repository analysis through the configured application AI mechanism. */
export interface RepositoryContextGenerator {
  generate(
    request: RepositoryContextGenerationRequest,
    onProgress?: (detail: string) => void,
  ): Promise<RepositoryContextGenerationResult>;
}

/** Abstract application AI primitive used by repository analysis. */
export interface RepositoryAnalysisExecutor {
  execute(request: {
    repositoryId: string;
    repositoryPath: string;
    prompt: string;
    maxOutputChars: number;
  }): Promise<string>;
}
