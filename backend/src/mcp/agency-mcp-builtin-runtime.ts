import { AGENCY_PUBLIC_MCPS } from './agency-mcp-catalog.js';
import type { McpBuiltinRuntime } from './mcp-builtin-runtime.js';

const BASE_FIELDS = ['type', 'enabled'];
// Verified public ado_to_cli_args mappings, not generic JSON-to-flag inference.
const ADO_FIELDS = ['organization', 'scope_to_current_organization', 'allow_cross_organization_fallback', 'legacy', 'toolsets'];
// Verified via installed public help and isolated config-set/read-back round trips.
const PUBLIC_OPTIONS: Record<string, Array<[string, string, 'string' | 'flag' | 'repeat' | 'json']>> = {
  bluebird: [
    ['organization', '--organization', 'string'], ['project', '--project', 'string'],
    ['repositories', '--repository', 'repeat'], ['branch', '--branch', 'string'],
    ['scopes', '--scopes', 'repeat'], ['mini', '--mini', 'flag'], ['full', '--full', 'flag'], ['local', '--local', 'flag'],
  ],
  kusto: [['service_uri', '--service-uri', 'string'], ['database', '--database', 'string'], ['known_services', '--known-services', 'json']],
  logger: [['connection_string', '--connection-string', 'string'], ['filestore_dir_name', '--filestore-dir-name', 'string']],
};

function argument(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && !value.startsWith('-') && !/[\u0000-\u001f]/.test(value);
}

function knownServices(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) =>
    typeof entry === 'object' && entry !== null && !Array.isArray(entry) &&
    argument(entry.service_uri) &&
    Object.entries(entry).every(([key, item]) =>
      ['service_uri', 'default_database', 'description'].includes(key) && typeof item === 'string'));
}

export function createAgencyMcpBuiltinRuntime(deps: { command: () => string; cwd: string }): McpBuiltinRuntime {
  const publicNames = new Set(AGENCY_PUBLIC_MCPS.map((entry) => entry.name));
  return {
    resolve(name, spec) {
      const canonical = Object.hasOwn(spec, 'type') ? spec.type : name;
      if (typeof canonical !== 'string' || !publicNames.has(canonical)) {
        return { supported: false, reason: 'The native built-in type is not in the verified public catalog.' };
      }
      const bindings = PUBLIC_OPTIONS[canonical] ?? [];
      const allowed = new Set([...BASE_FIELDS, ...(canonical === 'ado' ? ADO_FIELDS : bindings.map(([field]) => field))]);
      if (Object.keys(spec).some((key) => !allowed.has(key))) {
        return { supported: false, reason: 'This built-in has configured options without a verified native CLI mapping. Tool inspection is unavailable rather than silently dropping those options.' };
      }
      if (spec.enabled !== undefined && typeof spec.enabled !== 'boolean') {
        return { supported: false, reason: 'The native enabled setting must be a boolean.' };
      }
      if (spec.enabled === false) return { supported: false, reason: 'This native built-in is disabled.' };
      const args = ['mcp', canonical];
      if (canonical === 'ado') {
        for (const key of ['scope_to_current_organization', 'allow_cross_organization_fallback', 'legacy']) {
          if (spec[key] !== undefined && typeof spec[key] !== 'boolean') {
            return { supported: false, reason: 'Configured ADO boolean options have an invalid type.' };
          }
        }
        if ((spec.scope_to_current_organization === true && spec.organization !== undefined) ||
            (spec.allow_cross_organization_fallback === true && spec.scope_to_current_organization !== true)) {
          return { supported: false, reason: 'ADO organization conflicts with current-organization scope; cross-organization fallback requires that scope.' };
        }
        if (spec.organization !== undefined) {
          if (!argument(spec.organization)) {
            return { supported: false, reason: 'Configured ADO organization must be a nonempty native argument value.' };
          }
          args.push('--organization', spec.organization);
        }
        if (spec.scope_to_current_organization === true) args.push('--scope-to-current-organization');
        if (spec.allow_cross_organization_fallback === true) args.push('--allow-cross-organization-fallback');
        if (spec.legacy === true) args.push('--legacy');
        if (spec.toolsets !== undefined) {
          if (!Array.isArray(spec.toolsets) || spec.toolsets.length === 0 ||
              spec.toolsets.some((value) => typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value))) {
            return { supported: false, reason: 'Configured ADO toolsets must be a nonempty array of unambiguous native toolset names.' };
          }
          args.push('--toolsets', spec.toolsets.join(','));
        }
      }
      for (const [field, flag, kind] of bindings) {
        const value = spec[field];
        if (value === undefined) continue;
        if (kind === 'flag') {
          if (typeof value !== 'boolean') return { supported: false, reason: 'A configured native boolean option has an invalid type.' };
          if (value) args.push(flag);
        } else if (kind === 'repeat') {
          if (!Array.isArray(value) || !value.every(argument)) return { supported: false, reason: 'A configured repeated native option must contain argument strings.' };
          for (const item of value) args.push(flag, item);
        } else if (kind === 'json') {
          if (!knownServices(value)) return { supported: false, reason: 'Kusto known_services must contain only the documented service_uri, default_database and description string fields.' };
          args.push(flag, JSON.stringify(value));
        } else {
          if (!argument(value)) return { supported: false, reason: 'A configured native option must be a nonempty argument string without control characters.' };
          args.push(flag, value);
        }
      }
      const command = deps.command();
      if (/\.(?:cmd|bat)$/i.test(command)) {
        return { supported: false, reason: 'A directly executable Agency binary is required; shell wrappers are not used for native tool inspection.' };
      }
      return {
        supported: true, canonicalName: canonical,
        launch: { command, args, cwd: deps.cwd },
      };
    },
  };
}
