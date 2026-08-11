import { spawn } from 'node:child_process';
import { LineAssembler } from '../provider/process-kernel/stream-reader.js';
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
    inspect({ spec, timeoutMs }) {
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
        };

        const child = spawn(command, stringArray(spec.args), {
          env: envOf(spec),
          cwd: typeof spec.cwd === 'string' ? spec.cwd : undefined,
          stdio: 'pipe',
          shell: process.platform === 'win32',
          windowsHide: true,
        });

        const finish = (result: McpToolInspection): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          try {
            child.kill();
          } catch {
            // Best effort: the server may already have exited.
          }
          resolve(result);
        };

        const request = (method: string, params: unknown): Promise<unknown> => {
          const id = nextId++;
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
          return new Promise((resolveRequest) => {
            pending.set(id, resolveRequest);
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
        child.on('close', () => {
          if (!settled) {
            finish({
              status: 'failed',
              message: 'MCP server exited before tool discovery completed',
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
          const initRecord = asRecord(initialized);
          if (initRecord?.error) {
            finish({
              status: 'failed',
              message: 'MCP initialize failed',
              output,
              tools: [],
            });
            return;
          }
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
          const listed = await request('tools/list', {});
          const listRecord = asRecord(listed);
          if (listRecord?.error) {
            finish({
              status: 'failed',
              message: 'MCP tools/list failed',
              output,
              tools: [],
            });
            return;
          }
          finish({
            status: 'ok',
            message: null,
            output,
            tools: toolsFrom(listRecord?.result),
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
