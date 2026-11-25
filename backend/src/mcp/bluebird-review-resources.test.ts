import { describe, expect, it, vi } from 'vitest';
import type { PrReview } from '../pr-review/pr-review-contract.js';
import type { McpServerEntry } from './mcp-contract.js';
import { bluebirdReadTool, bluebirdReviewLaunch, createBluebirdReviewResources, type BluebirdReadRequest, type BluebirdReadResult } from './bluebird-review-resources.js';

const review = { repoId: 'repo', pull: { title: 'Validate IsMaterializedViewBuild requests' },
  changeGraph: { nodes: [{ path: 'service/handler.cpp' }] } } as PrReview;
const selection = { providerId: 'provider', model: 'auto' };
const server: McpServerEntry = { name: 'native-builtins:bluebird', origin: 'agency-built-in',
  builtinName: 'bluebird', spec: { type: 'bluebird', organization: 'example' } };
const launch = { command: 'agency.exe', args: ['mcp', 'bluebird'], cwd: 'C:\\repo' };

function harness(results: BluebirdReadResult[] = [{ tool: 'code_search', method: 'semantic', text: 'Reject untrusted background markers.' }]) {
  const repository = vi.fn(() => ({ remoteUrl: 'https://dev.azure.com/example/project/_git/repo' }));
  const read = vi.fn(async (_provider: string, _requests: BluebirdReadRequest[], _signal?: AbortSignal) => results);
  const resources = createBluebirdReviewResources({ repository, read, now: () => 'captured-time', maxChars: 2000 });
  return { resources, repository, read };
}

describe('read-only Bluebird review context', () => {
  it('uses the actual repository scope and targeted queries without requesting arbitrary tools or user input', async () => {
    const { resources, read } = harness();
    const controller = new AbortController();
    const result = await resources.collect(review, selection, controller.signal);
    expect(read).toHaveBeenCalledWith('provider', [
      { tool: 'metadata', arguments: { organization: 'example', project: 'project', repository: 'repo', method: 'repo_status' } },
      { tool: 'code_search', arguments: { organization: 'example', project: 'project', repository: 'repo',
        method: 'semantic', limit: 5, query: expect.stringContaining('service/handler.cpp') } },
      { tool: 'project_search', arguments: { organization: 'example', project: 'project', method: 'wiki',
        query: 'IsMaterializedViewBuild', limit: 3 } },
      { tool: 'project_search', arguments: { organization: 'example', project: 'project', method: 'work_items',
        query: 'IsMaterializedViewBuild', limit: 3 } },
    ], controller.signal);
    expect(result).toEqual({ sources: [{
      id: 'mcp:bluebird:0', source: 'mcp:bluebird:example/project/repo/code_search/semantic@captured-time',
      content: 'Reject untrusted background markers.', documented: false,
    }], warnings: [] });
  });

  it('does not send non-Azure repository context to an unrelated server', async () => {
    const { resources, repository, read } = harness();
    repository.mockReturnValue({ remoteUrl: 'https://github.com/example/repo.git' });
    expect(await resources.collect(review, selection)).toEqual({ sources: [], warnings: [] });
    expect(read).not.toHaveBeenCalled();
  });

  it('uses a bounded plain topic when no identifier is present, and omits empty searches', async () => {
    const { resources, read } = harness();
    await resources.collect({ ...review, pull: { ...review.pull, title: 'preserve retry billing behavior' } }, selection);
    expect(read.mock.calls[0][1][2].arguments.query).toBe('preserve retry');
    await resources.collect({ ...review, pull: { ...review.pull, title: 'a + b' } }, selection);
    expect(read.mock.calls[1][1]).toHaveLength(2);
  });

  it('keeps bounded complete responses and reports unavailable or oversized research without clipping captured code', async () => {
    const { resources, read } = harness([
      { tool: 'metadata', method: 'repo_status', text: '   ' }, { tool: 'code_search', method: 'semantic', text: 'x'.repeat(2001) },
    ]);
    const result = await resources.collect(review, selection);
    expect(result.sources).toEqual([]);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.join(' ')).toContain('existing review evidence is unchanged');
    read.mockResolvedValue([]);
    expect((await resources.collect(review, selection)).warnings[0]).toContain('criteria use captured');
  });

  it('propagates cancellation before and after retrieval', async () => {
    const { resources, read } = harness();
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(resources.collect(review, selection, controller.signal)).rejects.toThrow('cancelled');
    expect(read).not.toHaveBeenCalled();
    const next = new AbortController();
    read.mockImplementationOnce(async () => { next.abort(new Error('cancelled')); return []; });
    await expect(resources.collect(review, selection, next.signal)).rejects.toThrow('cancelled');
  });

  it('uses only an enabled, unambiguous configured native server and retains disabled tools', () => {
    const runtime = { resolve: vi.fn(() => ({ supported: true as const, launch })) };
    expect(bluebirdReviewLaunch([{ ...server, tools: [
      { name: 'code_search', enabled: true, description: null },
      { name: 'project_search', enabled: false, description: null },
    ] }], runtime)).toEqual({ spec: launch, allowedTools: ['code_search'] });
    expect(bluebirdReviewLaunch([{ ...server, spec: {} }], runtime)).toEqual({ spec: launch, allowedTools: null });
    expect(bluebirdReviewLaunch([{ ...server, name: 'global-builtins:bluebird' }], runtime)).toEqual({ spec: launch, allowedTools: null });
    expect(runtime.resolve).toHaveBeenCalledWith('bluebird', {});
  });

  it.each([
    { origin: 'custom' }, { spec: { type: 'other' } }, { catalog: true }, { configurationConflict: true },
    { enabled: false }, { authState: { state: 'required' } },
    { authState: { state: 'expired' } },
  ])('does not start unsupported, disabled, conflicted or authentication-required MCP declarations: %j', (overrides) => {
    const runtime = { resolve: vi.fn(() => ({ supported: false as const, reason: 'unsupported' })) };
    expect(bluebirdReviewLaunch([{ ...server, ...overrides } as McpServerEntry], runtime)).toBeNull();
    expect(runtime.resolve).not.toHaveBeenCalled();
  });

  it('does not guess launch flags for unsupported native settings', () => {
    const runtime = { resolve: vi.fn(() => ({ supported: false as const, reason: 'unsupported' })) };
    expect(bluebirdReviewLaunch([server], runtime)).toBeNull();
  });

  it('only selects known read methods, enabled native tools and schemas that explicitly accept the requested scope', () => {
    const request: BluebirdReadRequest = { tool: 'code_search', arguments: { method: 'semantic', organization: 'example' } };
    const tool = { name: 'code_search', inputSchema: { properties: { method: {}, organization: {} } } };
    expect(bluebirdReadTool(request, [tool], null)).toBe('code_search');
    expect(bluebirdReadTool(request, [{ ...tool, name: 'bluebird-code_search' }], ['bluebird-code_search'])).toBe('bluebird-code_search');
    expect(bluebirdReadTool(request, [{ ...tool, name: 'bluebird_code_search' }], null)).toBe('bluebird_code_search');
    expect(bluebirdReadTool(request, [{ ...tool, name: 'write' }], null)).toBeUndefined();
    expect(bluebirdReadTool(request, [tool], [])).toBeUndefined();
    expect(bluebirdReadTool(request, [{ ...tool, inputSchema: {} }], null)).toBeUndefined();
    expect(bluebirdReadTool({ ...request, arguments: { method: 'delete' } }, [tool], null)).toBeUndefined();
    expect(bluebirdReadTool({ ...request, tool: 'write' } as unknown as BluebirdReadRequest, [tool], null)).toBeUndefined();
  });
});
