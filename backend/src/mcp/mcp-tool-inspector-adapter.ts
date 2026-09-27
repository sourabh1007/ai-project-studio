import { spawn } from 'node:child_process';
import { LineAssembler } from '../provider/process-kernel/stream-reader.js';
import { killProcessTree } from '../provider/process-kernel/process-tree-kill.js';
import { classifyMcpAuth } from './mcp-auth-detect.js';
import { mcpInspectorLaunch } from './mcp-inspector-launch.js';
import type { McpToolInspection, McpToolInspector } from './mcp-contract.js';

const PROTOCOL_VERSION = '2024-11-05';
const MAX_OUTPUT_LINES = 80;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function envOf(spec: Record<string, unknown>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const configured = asRecord(spec.env);
  if (!configured) {
    return env;
  }
  for (const [key, value] of Object.entries(configured)) {
    if (typeof value === 'string') {
      env[key] = value;
    }
  }
  return env;
}

function toolsFrom(result: unknown): McpToolInspection['tools'] {
  const tools = asRecord(result)?.tools;
  if (!Array.isArray(tools)) {
    return [];
  }
  return tools.flatMap((tool) => {
    const record = asRecord(tool);
    if (!record) {
      return [];
    }
    const name = record.name;
    if (typeof name !== 'string' || name.length === 0) {
      return [];
    }
    return [{
      name,
      description:
        typeof record.description === 'string' ? record.description : null,
    }];
  });
}

/**
 * Starts a configured stdio MCP server just long enough to initialize it and ask
 * for `tools/list`. This is an IO adapter; service tests cover the behavior that
 * consumes its result.
 */
export function createMcpToolInspector(): McpToolInspector {
  return {
    inspect({ spec, timeoutMs, signal, onProgress }) {
      if (signal?.aborted) return Promise.resolve({
        status: 'failed', message: 'MCP inspection was cancelled', output: [], tools: [],
      });
      const command = typeof spec.command === 'string' ? spec.command : '';
      if (!command) {
        return Promise.resolve({
          status: 'failed',
          message: 'Only stdio MCP servers with a command can be inspected',
          output: [],
          tools: [],
        });
      }

      return new Promise<McpToolInspection>((resolve) => {
        const output: string[] = [];
        const pending = new Map<number, (result: unknown) => void>();
        const stdout = new LineAssembler();
        const stderr = new LineAssembler();
        let nextId = 1;
        let settled = false;
        let exited = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const append = (line: string): void => {
          const text = line.trim();
          if (text.length === 0) {
            return;
          }
          output.push(text);
          if (output.length > MAX_OUTPUT_LINES) {
            output.shift();
          }
          if (!settled && !exited) onProgress?.([...output]);
        };

        const launch = mcpInspectorLaunch(command, stringArray(spec.args), process.platform);
        const child = spawn(launch.command, launch.args, {
          env: envOf(spec),
          cwd: typeof spec.cwd === 'string' ? spec.cwd : undefined,
          stdio: 'pipe',
          shell: launch.shell,
          windowsVerbatimArguments: launch.windowsVerbatimArguments,
          windowsHide: true,
        });

        const finish = (
          result: Omit<McpToolInspection, 'authRequired' | 'authUrl'>,
        ): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          for (const resolveRequest of pending.values()) {
            resolveRequest({ error: { message: 'Inspection finished' } });
          }
          pending.clear();
          try {
            child.stdin.end();
            killProcessTree(child.pid, () => { child.kill(); });
          } catch {
            // Best effort: the server may already have exited.
          }
          // Successful inventory does not prove authorization of individual tools.
          const auth =
            result.status === 'ok'
              ? { authRequired: false, authUrl: null }
              : classifyMcpAuth(result.message, result.output);
          resolve({ ...result, ...auth });
        };
        const abort = (): void => {
          finish({ status: 'failed', message: 'MCP inspection was cancelled', output, tools: [] });
        };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) {
          abort();
          return;
        }

        const request = (method: string, params: unknown): Promise<unknown> => {
          const id = nextId++;
          return new Promise((resolveRequest) => {
            pending.set(id, resolveRequest);
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
          });
        };

        timer = setTimeout(() => {
          finish({
            status: 'failed',
            message: `Timed out after ${timeoutMs}ms while inspecting MCP tools`,
            output,
            tools: [],
          });
        }, timeoutMs);
        timer.unref();

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          for (const line of stdout.push(chunk)) {
            try {
              const message = asRecord(JSON.parse(line));
              const id = message?.id;
              if (typeof id === 'number') {
                const resolveRequest = pending.get(id);
                pending.delete(id);
                resolveRequest?.(message);
              } else {
                append(line);
              }
            } catch {
              append(line);
            }
          }
        });
        child.stderr.on('data', (chunk: string) => {
          for (const line of stderr.push(chunk)) {
            append(line);
          }
        });
        child.on('error', (error) => {
          finish({ status: 'failed', message: error.message, output, tools: [] });
        });
        child.on('exit', () => {
          exited = true;
          onProgress?.([]);
        });
        child.stdin.on('error', (error) => {
          finish({ status: 'failed', message: error.message, output, tools: [] });
        });
        child.on('close', () => {
          if (!settled) {
            append(stderr.flush() ?? '');
            const detail = output.slice(-3).join(' ').slice(0, 800);
            finish({
              status: 'failed',
              message: `MCP server exited before tool discovery completed${detail ? `: ${detail}` : ''}`,
              output,
              tools: [],
            });
          }
        });

        void (async () => {
          const initialized = await request('initialize', {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'AI Project Studio', version: '0.8.2' },
          });
          if (settled) return;
          const initRecord = asRecord(initialized);
          if (initRecord?.error || typeof asRecord(initRecord?.result)?.protocolVersion !== 'string') {
            const errorMessage = asRecord(initRecord?.error)?.message;
            if (typeof errorMessage === 'string') append(errorMessage);
            finish({
              status: 'failed',
              message: 'MCP initialize failed',
              output,
              tools: [],
            });
            return;
          }
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
          const tools: McpToolInspection['tools'] = [];
          const seenCursors = new Set<string>();
          let cursor: string | undefined;
          for (let page = 0; page < 20; page += 1) {
            const listed = await request('tools/list', cursor === undefined ? {} : { cursor });
            if (settled) return;
            const listRecord = asRecord(listed);
            const result = asRecord(listRecord?.result);
            if (listRecord?.error || !Array.isArray(result?.tools)) {
              const errorMessage = asRecord(listRecord?.error)?.message;
              if (typeof errorMessage === 'string') append(errorMessage);
              finish({ status: 'failed', message: 'MCP tools/list failed', output, tools: [] });
              return;
            }
            tools.push(...toolsFrom(result));
            if (tools.length > 2000) break;
            if (result.nextCursor === undefined) {
              finish({ status: 'ok', message: null, output, tools });
              return;
            }
            if (typeof result.nextCursor !== 'string' || seenCursors.has(result.nextCursor)) break;
            cursor = result.nextCursor;
            seenCursors.add(cursor);
          }
          finish({
            status: 'failed',
            message: 'MCP tool pagination was invalid or exceeded the bounded inventory limit',
            output,
            tools: [],
          });
        })().catch((error: unknown) => {
          finish({
            status: 'failed',
            message: error instanceof Error ? error.message : String(error),
            output,
            tools: [],
          });
        });
      });
    },
  };
}
