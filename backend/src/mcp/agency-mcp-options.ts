import type { AgencyMcpConfigRunner } from './agency-mcp-config-store.js';
import { AGENCY_PUBLIC_MCPS } from './agency-mcp-catalog.js';
import type { McpCommandOptions } from './mcp-contract.js';

export interface McpOptionsProvider {
  get(name: string): Promise<McpCommandOptions>;
}

const COMMAND = 'agency config set --global --mcp';
// These belong to the proxy/outer CLI, not the persisted built-in specification.
const PROXY_FLAGS = new Set(['--help', '--version', '--no-config-cache', '--no-aec', '--transport', '--port', '--entra-client-id']);
const description = (value: string): string => value.split(/\[(?:env|default|aliases):/i)[0].trim();

export function parseAgencyMcpOptions(name: string, text: string): McpCommandOptions['options'] | null {
  const lines = text.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/);
  if (!lines.some((line) => line.startsWith('Usage: ') && (line.includes(` mcp ${name} `) || line.endsWith(` mcp ${name}`)))) return null;
  const start = lines.findIndex((line) => line.trim() === 'Options:');
  if (start < 0) return null;
  const options: McpCommandOptions['options'] = [];
  let current: McpCommandOptions['options'][number] | undefined;
  let choices = false;
  for (const line of lines.slice(start + 1)) {
    if (line && !/^\s/.test(line)) break;
    const option = /^\s+(?:-[A-Za-z],\s+)?(--[a-z][a-z0-9-]*)(?:\s+<([^>]+)>(?:\.\.\.)?)?(?:\s{2,}(.*))?\s*$/.exec(line);
    if (option) {
      choices = false;
      current = PROXY_FLAGS.has(option[1]) ? undefined : {
        flag: option[1], description: description(option[3] ?? ''),
        ...(option[2] ? { valueHint: option[2] } : {}),
      };
      if (current) options.push(current);
      continue;
    }
    if (/^\s+(?:-[A-Za-z],\s+)?--/.test(line)) return null;
    if (!current || !line.trim()) continue;
    const value = line.trim();
    const inlineChoices = /^\[possible values: ([^\]]+)\]$/i.exec(value);
    if (inlineChoices) { current.choices = inlineChoices[1].split(',').map((item) => item.trim()); continue; }
    if (value === 'Possible values:') { choices = true; current.choices = []; continue; }
    if (choices && value.startsWith('- ')) {
      current.choices!.push(value.slice(2).split(':')[0].trim());
      continue;
    }
    if (value.startsWith('[')) continue;
    current.description = [current.description, description(value)].filter(Boolean).join(' ');
  }
  return options;
}

/** Bounded, single-flight public help reads. Failures never expose native stdout/stderr. */
export function createAgencyMcpOptions(deps: {
  runner: AgencyMcpConfigRunner; now: () => number; ttlMs: number; maxConcurrent: number;
}): McpOptionsProvider {
  const allowed = new Set(AGENCY_PUBLIC_MCPS.map((entry) => entry.name));
  const cache = new Map<string, { value: McpCommandOptions; retryAt: number }>();
  const active = new Map<string, Promise<McpCommandOptions>>();
  let running = 0;
  const unavailable = (message: string): McpCommandOptions => ({
    command: COMMAND, options: [], examples: [], cachedAt: null, stale: false, message,
  });
  return {
    async get(name) {
      if (!allowed.has(name)) return unavailable('Options are available only for verified public Agency built-in types.');
      const previous = cache.get(name);
      if (previous && previous.retryAt > deps.now()) return structuredClone(previous.value);
      const pending = active.get(name);
      if (pending) return structuredClone(await pending);
      if (running >= deps.maxConcurrent) return unavailable('Native help discovery is busy. Try again after the current reads finish.');
      running += 1;
      const read = (async (): Promise<McpCommandOptions> => {
        try {
          const result = await deps.runner.run(['mcp', name, '--help']);
          const options = result.code === 0 ? parseAgencyMcpOptions(name, result.stdout) : null;
          if (options === null) throw new Error('Unrecognized help');
          const value: McpCommandOptions = {
            command: COMMAND, options,
            examples: options.slice(0, 3).map((option) => option.valueHint
              ? `${option.flag} ${option.choices?.[0] ?? `<${option.valueHint}>`}` : option.flag),
            cachedAt: new Date(deps.now()).toISOString(), stale: false,
            message: options.length ? 'Suggestions come from installed public CLI help. They do not imply authentication or a live connection.'
              : 'No server-specific configuration options are advertised by this installed built-in.',
          };
          cache.set(name, { value, retryAt: deps.now() + deps.ttlMs });
          return value;
        } catch {
          const value = previous?.value.cachedAt ? {
            ...previous.value, stale: true,
            message: 'Native help refresh failed. These previously observed suggestions may be outdated.',
          } : unavailable('Native help is unavailable or unrecognized. No options were guessed; use options-only input, not a full shell command.');
          cache.set(name, { value, retryAt: deps.now() + Math.min(deps.ttlMs, 30_000) });
          return value;
        }
      })();
      active.set(name, read);
      try { return structuredClone(await read); }
      finally { active.delete(name); running -= 1; }
    },
  };
}
