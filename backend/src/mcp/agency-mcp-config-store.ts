import { parseDocument } from 'yaml';
import { ProviderError, ValidationError } from '../kernel/error-types.js';
import type { McpConfigDocument, McpConfigFileStore } from './mcp-contract.js';

export interface AgencyMcpConfigRunner {
  run(args: string[]): Promise<{ code: number; stdout: string; stderr?: string }>;
}

export interface AgencyMcpConfigStoreDeps {
  runner: AgencyMcpConfigRunner;
  sourcePath: string;
  scope?: 'global';
}

/** Read resolved native configuration only; generic object setters are unsafe for TOML. */
export function createAgencyMcpConfigStore(deps: AgencyMcpConfigStoreDeps): McpConfigFileStore {
  async function run(args: string[]): Promise<string | null> {
    let result: Awaited<ReturnType<AgencyMcpConfigRunner['run']>>;
    try { result = await deps.runner.run(args); }
    catch { throw new ProviderError('Agency configuration command is unavailable. Install or configure Agency and inspect its native configuration.'); }
    if (deps.scope === 'global' && result.code === 1 && result.stdout.trim() === '' &&
        /^Error: Failed to load global config: Failed to read config file [^\r\n]+: The system cannot find the file specified\. \(os error 2\)$/.test(
          (result.stderr ?? '').replace(/\x1b\[[0-9;]*m/g, '').trim().split(/\r?\n/).at(-1)!,
        )) return null;
    if (result.code === 1 && result.stdout.trim() === '' &&
        /^(?:Error:\s*)?Key 'mcps' not found in config$/.test(
          (result.stderr ?? '').replace(/\x1b\[[0-9;]*m/g, '').trim().split(/\r?\n/).at(-1)!,
        )) return null;
    if (result.code !== 0) throw new ProviderError('Agency configuration command failed. Unrecognized CLI errors are not treated as an empty configuration.');
    return result.stdout;
  }
  return {
    async read(path): Promise<McpConfigDocument | null> {
      if (path !== deps.sourcePath) throw new ValidationError('Unknown Agency configuration source.');
      const text = await run(['config', 'get', ...(deps.scope === 'global' ? ['--global'] : []), 'mcps']);
      if (text === null) return null;
      try {
        const parsed = parseDocument(text);
        if (parsed.errors.length > 0) throw new Error('Invalid YAML');
        const mcps: unknown = parsed.toJS({ maxAliasCount: 100 });
        if (typeof mcps !== 'object' || mcps === null || Array.isArray(mcps)) throw new Error('Expected map');
        return { mcps };
      } catch {
        throw new ValidationError('Agency did not return a valid YAML mcps map. No configuration was replaced.');
      }
    },
    async write() {
      throw new ValidationError('Agency resolved configuration is read-only here. Its writable source is not reliably identified, and object config setters can corrupt TOML. Edit the native configuration at its source; no automatic format conversion is performed.');
    },
  };
}
