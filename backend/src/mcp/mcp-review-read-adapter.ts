import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import type { BluebirdReadRequest, BluebirdReadResult, ReviewMcpLaunch } from './bluebird-review-resources.js';
import { bluebirdReadTool } from './bluebird-review-resources.js';

/** Bounded, explicitly scoped read calls; no model-supplied tool names or arguments. */
export async function readReviewMcpResources(input: {
  launch: ReviewMcpLaunch;
  requests: BluebirdReadRequest[];
  timeoutMs: number;
  maxChars: number;
  signal?: AbortSignal;
  onStart?: (handle: { kill(): void; done: Promise<number | null> }) => void;
}): Promise<BluebirdReadResult[]> {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(input.timeoutMs),
    ...(input.signal ? [input.signal] : [])]);
  const spec = input.launch.spec;
  const client = new Client({ name: 'AI Project Studio review context', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: spec.command as string,
    args: spec.args as string[],
    cwd: spec.cwd as string,
    stderr: 'ignore',
    env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    maxBufferSize: Math.min(input.maxChars * 10, 8_388_608),
  });
  let acknowledge!: (code: number | null) => void;
  const done = new Promise<number | null>((resolve) => { acknowledge = resolve; });
  const results: BluebirdReadResult[] = [];
  try {
    signal.throwIfAborted();
    input.onStart?.({ kill: () => controller.abort(), done });
    await client.connect(transport, { signal, timeout: input.timeoutMs });
    const inventory = await client.listTools({}, { signal, timeout: input.timeoutMs });
    for (const request of input.requests) {
      if (signal.aborted) break;
      const tool = bluebirdReadTool(request, inventory.tools, input.launch.allowedTools);
      if (!tool) continue;
      try {
        const result = await client.callTool({ name: tool, arguments: request.arguments },
          undefined, { signal, timeout: input.timeoutMs });
        if (result.isError) continue;
        const text = (result.content as Array<{ type: string; text?: string }>)
          .filter((entry) => entry.type === 'text').map((entry) => entry.text ?? '').join('\n');
        if (text.length <= input.maxChars) results.push({ tool: request.tool, method: String(request.arguments.method), text });
      } catch {
        // A missing index or an unavailable resource must not abort the review.
      }
    }
    return results;
  } finally {
    try {
      // Stop native wrapper descendants before closing the root process.
      if (process.platform === 'win32' && transport.pid !== null) {
        await new Promise<void>((resolve) => {
          execFile(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
            ['/pid', String(transport.pid), '/t', '/f'],
            { timeout: 4000, windowsHide: true }, () => resolve());
        });
      }
      await client.close();
    } finally { acknowledge(null); }
    input.signal?.throwIfAborted();
  }
}
