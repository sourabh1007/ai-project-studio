import type { ContextConfig } from './config.js';
import type { ContextScope } from './context-contract.js';

/** A resolved layer ready for injection, in cascade order. */
export interface ResolvedLayer {
  scope: ContextScope;
  content: string;
}

function clamp(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxChars).trimEnd()}…`;
}

/**
 * Renders the layered `## Shared Context` block from already-resolved layer
 * documents. Layers with empty content are skipped; each surviving layer is
 * bounded by {@link ContextConfig.maxInjectCharsPerLayer}. Returns `''` when no
 * layer has content, so callers can omit the block entirely.
 */
export function composeSharedContext(
  layers: ResolvedLayer[],
  config: ContextConfig,
): string {
  const blocks: string[] = [];
  for (const layer of layers) {
    const bounded = clamp(layer.content, config.maxInjectCharsPerLayer);
    if (bounded.length === 0) {
      continue;
    }
    blocks.push(`${config.layerHeadings[layer.scope]}\n\n${bounded}`);
  }
  if (blocks.length === 0) {
    return '';
  }
  return `${config.sectionHeading}\n\n${blocks.join('\n\n')}`;
}
