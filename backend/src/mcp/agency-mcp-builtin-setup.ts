import { ProviderError, ValidationError } from '../kernel/error-types.js';
import type { AgencyMcpCatalog } from './agency-mcp-catalog.js';
import type { AgencyMcpConfigRunner } from './agency-mcp-config-store.js';
import type { McpConfigDocument, McpConfigFileStore } from './mcp-contract.js';
import type { McpConfigWrites } from './mcp-config-writes.js';
import { normalizeAgencyMcpArguments } from './agency-mcp-arguments.js';

export interface McpBuiltinSetup {
  configure(name: string, args: string, mode: 'add' | 'edit'): Promise<void>;
  /**
   * Enables or disables a global built-in using the native scalar config setter,
   * preserving any configured arguments. Argument-configured object entries are
   * toggled at `mcps.builtins.<name>.enabled`; bare-boolean entries, and installed
   * catalog built-ins with no explicit global entry yet, are written as a whole
   * scalar at `mcps.builtins.<name>`. The persisted state is verified before the
   * call resolves.
   */
  setEnabled(name: string, enabled: boolean): Promise<void>;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function builtinMap(document: McpConfigDocument | null): Record<string, unknown> {
  if (document === null) return {};
  if (!object(document.mcps)) throw new ValidationError('Global Agency mcps must be an object before setup.');
  const { builtins, servers } = document.mcps;
  if (servers !== undefined && !object(servers)) throw new ValidationError('Global Agency custom servers must be an object before setup.');
  if (builtins !== undefined && !object(builtins)) throw new ValidationError('Global Agency built-ins must be an object before setup.');
  return builtins ?? {};
}

/** Native --mcp owns TOML/YAML updates. Never use the generic object setter. */
export function createAgencyMcpBuiltinSetup(deps: {
  runner: AgencyMcpConfigRunner;
  catalog: () => Promise<AgencyMcpCatalog>;
  globalStore: McpConfigFileStore;
  globalSource: string;
  writes: McpConfigWrites;
}): McpBuiltinSetup {
  let pending = 0;
  return {
    async configure(name, args, mode) {
      if (typeof args !== 'string' || args.length > 4096 || /[\r\n\0]/.test(args)) {
        throw new ValidationError('Built-in arguments must be a single line of at most 4096 characters without NUL.');
      }
      if (!/^[a-z][a-z0-9_-]*$/.test(name)) throw new ValidationError('Invalid Agency built-in name.');
      const normalizedArguments = normalizeAgencyMcpArguments(args);
      if (pending >= 2) throw new ValidationError('Agency global setup is busy. Wait for the pending configuration changes.');
      pending += 1;
      try {
        await deps.writes.run(deps.globalSource, async () => {
          const available = await deps.catalog();
          if (!available.servers.some((entry) => entry.builtinName === name)) {
            throw new ValidationError('This built-in is not in the installed, public Agency catalog. Refresh before configuring.');
          }
          const before = await deps.globalStore.read(deps.globalSource);
          const builtins = builtinMap(before);
          const exists = Object.hasOwn(builtins, name);
          if (mode === 'add' && exists) throw new ValidationError('This built-in already exists globally. Refresh and edit its global entry instead.');
          if (mode === 'edit' && !exists) throw new ValidationError('This global built-in was removed. Refresh before configuring.');
          if (exists && typeof builtins[name] !== 'boolean' && !object(builtins[name])) {
            throw new ValidationError('The existing global built-in is malformed. Repair it before configuring.');
          }
          if (before && object(before.mcps) && object(before.mcps.servers) && Object.hasOwn(before.mcps.servers, name)) {
            throw new ValidationError('A custom server with this name exists globally. Resolve the name conflict in Agency before configuring a built-in.');
          }
          const specification = normalizedArguments ? `${name} ${normalizedArguments}` : name;
          let code: number;
          try {
            ({ code } = await deps.runner.run(['config', 'set', '--global', '--mcp', specification]));
          } catch {
            throw new ProviderError('Agency setup did not complete within bounded command execution. Its persistence is unknown; refresh global configuration before trying again. No automatic retry was performed.');
          }
          if (code !== 0) throw new ProviderError('Agency rejected built-in setup. Check the built-in parameters in native help. Configuration may have changed; refresh before trying again. CLI output is withheld because it may contain credentials.');
          try {
            const after = builtinMap(await deps.globalStore.read(deps.globalSource));
            if (!Object.hasOwn(after, name) || (typeof after[name] !== 'boolean' && !object(after[name]))) {
              throw new Error('Missing persisted built-in');
            }
          } catch {
            throw new ProviderError('Agency reported success, but the global built-in could not be verified. No configured state is claimed; refresh global configuration. Setup was not retried.');
          }
        });
      } finally { pending -= 1; }
    },
    async setEnabled(name, enabled) {
      if (!/^[a-z][a-z0-9_-]*$/.test(name)) throw new ValidationError('Invalid Agency built-in name.');
      if (typeof enabled !== 'boolean') throw new ValidationError('The enabled flag must be a boolean.');
      if (pending >= 2) throw new ValidationError('Agency global setup is busy. Wait for the pending configuration changes.');
      pending += 1;
      try {
        await deps.writes.run(deps.globalSource, async () => {
          const before = await deps.globalStore.read(deps.globalSource);
          const builtins = builtinMap(before);
          const configured = Object.hasOwn(builtins, name);
          if (!configured) {
            // An installed catalog built-in that Agency enables by default has no explicit
            // global entry. Writing an explicit scalar override (true/false) is how the user
            // pins it on or off. Validate it is a real, installed built-in and free of a
            // custom-server name clash before authoring that override.
            const available = await deps.catalog();
            if (!available.servers.some((entry) => entry.builtinName === name)) {
              throw new ValidationError('This built-in is not configured globally and is not in the installed, public Agency catalog. Refresh before enabling or disabling it.');
            }
            if (before && object(before.mcps) && object(before.mcps.servers) && Object.hasOwn(before.mcps.servers, name)) {
              throw new ValidationError('A custom server with this name exists globally. Resolve the name conflict in Agency before pinning a built-in.');
            }
          }
          const current = configured ? builtins[name] : undefined;
          if (configured && typeof current !== 'boolean' && !object(current)) {
            throw new ValidationError('The existing global built-in is malformed. Repair it before enabling or disabling it.');
          }
          // Object entries carry arguments: toggle the scalar `.enabled` subpath so they survive.
          // Bare-boolean or absent entries have no subpath and are written as a whole scalar.
          const path = object(current) ? `mcps.builtins.${name}.enabled` : `mcps.builtins.${name}`;
          let code: number;
          try {
            ({ code } = await deps.runner.run(['config', 'set', '--global', path, enabled ? 'true' : 'false']));
          } catch {
            throw new ProviderError('Agency enable/disable did not complete within bounded command execution. Its persistence is unknown; refresh global configuration before trying again. No automatic retry was performed.');
          }
          if (code !== 0) throw new ProviderError('Agency rejected the built-in enable/disable change. Configuration may have changed; refresh before trying again. CLI output is withheld because it may contain credentials.');
          let effective: boolean | undefined;
          try {
            const after = builtinMap(await deps.globalStore.read(deps.globalSource));
            const value = after[name];
            effective = typeof value === 'boolean' ? value : object(value) ? value.enabled !== false : undefined;
          } catch {
            throw new ProviderError('Agency reported success, but the global built-in state could not be re-read. No state is claimed; refresh global configuration. The change was not retried.');
          }
          if (effective !== enabled) {
            throw new ProviderError('Agency reported success, but the enable/disable change could not be verified. No state is claimed; refresh global configuration. The change was not retried.');
          }
        });
      } finally { pending -= 1; }
    },
  };
}
