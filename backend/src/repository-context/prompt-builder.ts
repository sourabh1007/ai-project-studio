import type { RepositoryContextConfig } from './config.js';
import type { RepositoryEvidence } from './repository-context-contract.js';

function delimitUntrusted(label: string, source: string): string {
  return [
    `----- BEGIN UNTRUSTED REPOSITORY ${label} -----`,
    source,
    `----- END UNTRUSTED REPOSITORY ${label} -----`,
  ].join('\n');
}

function formatEvidence(evidence: RepositoryEvidence): string {
  const sections = [
    delimitUntrusted('TREE', evidence.tree),
    ...evidence.files.map((file) =>
      delimitUntrusted(`FILE: ${file.path}`, file.content),
    ),
  ];
  return sections.join('\n\n');
}

/** Builds a read-only single-pass analysis prompt from bounded evidence. */
export function buildRepositoryAnalysisPrompt(
  evidence: RepositoryEvidence,
  config: RepositoryContextConfig,
): string {
  return config.analysisPromptTemplate.replace(
    '{{evidence}}',
    formatEvidence(evidence),
  );
}

/** Builds a read-only prompt for one large-repository evidence chunk. */
export function buildRepositoryChunkPrompt(
  chunkLabel: string,
  evidence: RepositoryEvidence,
  config: RepositoryContextConfig,
): string {
  return config.chunkPromptTemplate
    .replace('{{chunkLabel}}', chunkLabel)
    .replace('{{evidence}}', formatEvidence(evidence));
}

/** Builds a final synthesis prompt from bounded, untrusted chunk summaries. */
export function buildRepositorySynthesisPrompt(
  chunkSummaries: readonly string[],
  config: RepositoryContextConfig,
): string {
  const summaries = chunkSummaries
    .map((summary, index) =>
      delimitUntrusted(`CHUNK SUMMARY ${index + 1}`, summary),
    )
    .join('\n\n');
  return config.synthesisPromptTemplate.replace('{{chunkSummaries}}', summaries);
}

/** Trims generated output and enforces the persisted context limit. */
export function normalizeRepositoryContext(
  content: string,
  config: RepositoryContextConfig,
): string {
  return content.trim().slice(0, config.maxOutputChars);
}

