import type { McpServerEntry } from './mcp-contract.js';
import type { McpBuiltinRuntime } from './mcp-builtin-runtime.js';
import type { ReviewContextResourcesPort } from '../review-board/review-run-contract.js';
import { parseAzureRepoUrl } from '../repo/azure-pr-lister.js';

export interface BluebirdReadRequest {
  tool: 'metadata' | 'code_search' | 'project_search';
  arguments: Record<string, unknown>;
}

export interface BluebirdReadResult {
  tool: BluebirdReadRequest['tool'];
  method: string;
  text: string;
}

export interface ReviewMcpLaunch {
  spec: Record<string, unknown>;
  allowedTools: string[] | null;
}

export function bluebirdReadTool(request: BluebirdReadRequest,
  tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }>,
  allowedTools: string[] | null): string | undefined {
  const methods: Record<string, string[]> = {
    metadata: ['repo_status'], code_search: ['semantic'], project_search: ['wiki', 'work_items'],
  };
  if (!methods[request.tool]?.includes(String(request.arguments.method))) return undefined;
  return tools.find((tool) =>
    (tool.name === request.tool || tool.name.endsWith(`-${request.tool}`) || tool.name.endsWith(`_${request.tool}`)) &&
    (allowedTools === null || allowedTools.includes(tool.name)) &&
    Object.keys(request.arguments).every((key) => Object.hasOwn(tool.inputSchema.properties ?? {}, key)))?.name;
}

export function bluebirdReviewLaunch(servers: readonly McpServerEntry[], runtime: McpBuiltinRuntime): ReviewMcpLaunch | null {
  const entry = servers.find((server) => server.origin === 'agency-built-in' &&
    (server.spec.type ?? server.builtinName) === 'bluebird' &&
    !server.catalog && !server.configurationConflict && server.enabled !== false &&
    server.authState?.state !== 'required' && server.authState?.state !== 'expired');
  if (!entry) return null;
  const resolved = runtime.resolve(entry.builtinName!, entry.spec);
  if (!resolved.supported) return null;
  return { spec: resolved.launch, allowedTools: entry.tools
    ? entry.tools.filter((tool) => tool.enabled).map((tool) => tool.name) : null };
}

/** Source collection is separate from the no-tools review model and never follows source instructions. */
export function createBluebirdReviewResources(deps: {
  repository: (id: string) => { remoteUrl: string };
  read: (providerId: string, requests: BluebirdReadRequest[], signal?: AbortSignal) =>
    Promise<BluebirdReadResult[]>;
  now: () => string;
  maxChars: number;
}): ReviewContextResourcesPort {
  return {
    async collect(review, selection, signal) {
      signal?.throwIfAborted();
      const target = parseAzureRepoUrl(deps.repository(review.repoId).remoteUrl);
      if (!target) return { sources: [], warnings: [] };
      const scope = { organization: target.org, project: target.project, repository: target.repo };
      const title = review.pull.title;
      const topic = title.match(/\b[A-Z][a-z]+(?:[A-Z][A-Za-z0-9]*)+\b/g)?.at(-1) ??
        title.replace(/[^\w -]/g, ' ').split(/\s+/).filter((word) => word.length > 3).slice(0, 2).join(' ');
      const requests: BluebirdReadRequest[] = [
        { tool: 'metadata', arguments: { ...scope, method: 'repo_status' } },
        { tool: 'code_search', arguments: { ...scope, method: 'semantic', limit: 5,
          query: `Expected behavior, invariants, related tests and failure handling for this change: ${title}. Changed paths: ${
            review.changeGraph.nodes.slice(0, 12).map((node) => node.path).join(', ')}` } },
        ...(topic ? [
          { tool: 'project_search' as const, arguments: { organization: target.org, project: target.project,
            method: 'wiki', query: topic, limit: 3 } },
          { tool: 'project_search' as const, arguments: { organization: target.org, project: target.project,
            method: 'work_items', query: topic, limit: 3 } },
        ] : []),
      ];
      const results = await deps.read(selection.providerId, requests, signal);
      signal?.throwIfAborted();
      const sources = [];
      const warnings = [];
      for (const [index, result] of results.entries()) {
        if (!result.text.trim()) continue;
        if (result.text.length > deps.maxChars) {
          warnings.push(`Bluebird ${result.tool} response was too large to capture; existing review evidence is unchanged.`);
          continue;
        }
        sources.push({ id: `mcp:bluebird:${index}`,
          source: `mcp:bluebird:${target.org}/${target.project}/${target.repo}/${result.tool}/${result.method}@${deps.now()}`,
          content: result.text, documented: false });
      }
      if (!sources.length) warnings.push('Bluebird context was unavailable; criteria use captured PR and repository evidence.');
      return { sources, warnings };
    },
  };
}
