import { NotFoundError, ValidationError } from '../kernel/error-types.js';
import { unwrapServerSpec } from './mcp-proxy-config.js';
import { createMcpConfigWrites, type McpConfigWrites } from './mcp-config-writes.js';
import type { AgencyMcpCatalog } from './agency-mcp-catalog.js';
import type { McpBuiltinSetup } from './agency-mcp-builtin-setup.js';
import { mergeBuiltinSources } from './mcp-builtin-sources.js';
import type { McpBuiltinRuntime } from './mcp-builtin-runtime.js';
import type { McpAuthenticationJobs } from './mcp-authentication-jobs.js';
import { nativeToolInspection } from './native-mcp-auth.js';
import { mcpCommandPreview } from './mcp-command-preview.js';
import { mcpObservationKey, observedMcpAuth } from './mcp-auth-observations.js';
import type { McpOptionsProvider } from './agency-mcp-options.js';
import type { McpService } from './mcp-service.js';
import type {
  McpApplyResult, McpCapabilities, McpConfigDocument, McpConfigFileStore,
  McpOperation, McpProviderInfo, McpServerEntry, McpServerInput,
  McpToolEntry, McpToolInspector, ProviderMcpConfig,
  McpServerStatus, McpToolInspection, McpAuthObservationStore,
} from './mcp-contract.js';

export interface McpCategorySource {
  id: string;
  path: string;
  scope: string;
  store: McpConfigFileStore;
  /** Source-relative map, e.g. projects[workspace].mcpServers. */
  segments: string[];
  readOnlyReason?: string;
  builtin?: boolean;
  builtinScope?: 'resolved' | 'global';
  supportsEnabled?: boolean;
  supportsToolAllowList?: boolean;
  /** Keys a provider does not recognize; never write invented controls. */
  forbiddenSpecKeys?: string[];
  toggleReason?: string;
  toolToggleReason?: string;
  restartReason?: string;
  allowBareMap?: boolean;
  missingNotice?: string;
}

export interface McpCategory {
  info: McpProviderInfo;
  sources: McpCategorySource[];
  notices: string[];
  exclusiveSource?: McpCategorySource;
  unavailableReason?: string;
  disabledNamesSource?: { path: string; store: McpConfigFileStore; segments: string[] };
  catalog?: () => Promise<AgencyMcpCatalog>;
  builtinSetup?: { source: McpCategorySource; manager: McpBuiltinSetup };
  builtinRuntime?: McpBuiltinRuntime;
  options?: McpOptionsProvider;
}

export interface McpCategoryServiceDeps {
  categories: McpCategory[];
  enabled: () => boolean;
  tools: McpToolInspector;
  probeTimeoutMs: number;
  maxConcurrentProbes: number;
  writes?: McpConfigWrites;
  authenticationJobs?: McpAuthenticationJobs;
  authenticationTimeoutMs?: number;
  now: () => Date;
  maxAuthObservations: number;
  authObservationStore?: McpAuthObservationStore;
  studio: { name: string; spec: Record<string, unknown>; tools: McpToolEntry[]; probe?: () => Promise<McpServerStatus> };
}

const OPERATIONS: McpOperation[] = ['add', 'edit', 'remove', 'toggle', 'tools', 'toolToggle', 'restart'];
const PROBE_NOTICE = 'Independent stdio tools probe only; this is not the CLI connection and does not restart or reload any running CLI session.';
const NATIVE_NOTICE = 'Use the provider CLI MCP interface for remote connections and authentication; this manager does not perform native OAuth.';
const LIFECYCLE_NOTICE = 'This server is owned by the app lifecycle. Its configuration and running sessions cannot be changed here.';

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function capabilities(overrides: Partial<Record<McpOperation, string | null>>): McpCapabilities {
  return Object.fromEntries(OPERATIONS.map((op) => [op, {
    supported: overrides[op] === null,
    reason: overrides[op] === null ? null : overrides[op] ?? 'This operation is not supported for this source.',
  }])) as McpCapabilities;
}

function sourceCapabilities(source: McpCategorySource): McpCapabilities {
  const readOnly = source.readOnlyReason;
  return capabilities({
    add: readOnly ?? (source.builtin ? 'Built-ins are provided by Agency, not created here.' : null),
    edit: readOnly ?? null,
    remove: readOnly ?? (source.builtin ? 'Disable built-ins instead of deleting them.' : null),
    toggle: readOnly ?? source.toggleReason ?? (source.supportsEnabled ? null : 'This source has no supported enabled field. Use the native CLI controls.'),
    toolToggle: readOnly ?? source.toolToggleReason ?? (source.supportsToolAllowList ? null : 'This provider does not support a tools allow-list in server configuration. Use native tool permissions.'),
    tools: null,
    restart: source.restartReason ?? null,
  });
}

function mapAt(document: McpConfigDocument, segments: string[], create: boolean): Record<string, unknown> {
  let value: Record<string, unknown> = document;
  for (const key of segments) {
    if (!Object.hasOwn(value, key)) {
      if (!create) return {};
      Object.defineProperty(value, key, { value: {}, enumerable: true, writable: true, configurable: true });
    }
    const next = value[key];
    if (!object(next)) throw new ValidationError('MCP source contains a non-object configuration map; repair it in the native configuration before editing.');
    value = next;
  }
  return value;
}

function actionId(source: McpCategorySource, name: string): string {
  return `${source.id}:${encodeURIComponent(name)}`;
}

function serverMap(document: McpConfigDocument, source: McpCategorySource, create: boolean): Record<string, unknown> {
  return mapAt(document, source.allowBareMap && !Object.hasOwn(document, 'mcpServers') ? [] : source.segments, create);
}

function disabledNames(document: McpConfigDocument | null, segments: string[]): Set<string> {
  let value: unknown = document;
  for (const segment of segments) {
    if (value === undefined || value === null) return new Set();
    if (!object(value)) throw new ValidationError('Native disabled-server settings are malformed.');
    value = Object.hasOwn(value, segment) ? value[segment] : undefined;
  }
  if (value === undefined) return new Set();
  if (!Array.isArray(value) || value.some((name) => typeof name !== 'string')) {
    throw new ValidationError('Native disabled-server settings are malformed.');
  }
  return new Set(value);
}

function stdio(spec: Record<string, unknown>): boolean {
  return typeof spec.command === 'string' && spec.command.trim().length > 0 &&
    spec.url === undefined && (spec.type === undefined || spec.type === 'stdio' || spec.type === 'local');
}

function entryFor(source: McpCategorySource, name: string, raw: unknown): McpServerEntry {
  const valid = object(raw) || (source.builtin && typeof raw === 'boolean');
  let spec = object(raw) ? unwrapServerSpec(raw) :
    source.builtin && typeof raw === 'boolean' ? { enabled: raw } : {};
  let caps = valid ? sourceCapabilities(source) : capabilities({});
  const enabled = source.supportsEnabled ? spec.enabled !== false : true;
  if (!stdio(spec) || !enabled) {
    const reason = enabled ? NATIVE_NOTICE : 'Enable the server before probing its tools.';
    caps.tools = caps.restart = { supported: false, reason };
  }
  if (source.builtin) {
    caps.tools = caps.restart = { supported: false, reason: 'Agency resolves built-ins internally. Inspect their connection and tools in Agency.' };
    caps.toolToggle = { supported: false, reason: 'Edit the documented built-in tools allow-list directly; tool discovery belongs to Agency.' };
  }
  if (object(spec.env) && Object.hasOwn(spec.env, 'STUDIO_CONTROL_TOKEN')) {
    const { STUDIO_CONTROL_TOKEN: _token, ...env } = spec.env;
    spec = { ...spec, env };
    caps = capabilities(Object.fromEntries(OPERATIONS.map((op) => [op, 'This app-managed launch configuration contains private lifecycle credentials and cannot be operated on here.'])));
  }
  return {
    name: actionId(source, name), displayName: name, source: source.path,
    scope: source.scope, spec, enabled, capabilities: caps,
    origin: source.builtin ? 'agency-built-in' : 'custom',
    providerLabel: source.builtin ? 'Agency' : 'Custom',
    ...(source.builtin && valid ? { builtinName: name } : {}),
    toolDiscovery: { status: 'skipped', message: 'Not probed. Listing configuration does not connect to servers.', output: [] },
  };
}

interface Located { source: McpCategorySource; rawName: string; entry: McpServerEntry }

/** Capability-aware HTTP facade. It deliberately never uses the session registry or meta runner. */
export function createMcpCategoryService(deps: McpCategoryServiceDeps): McpService {
  const writes = deps.writes ?? createMcpConfigWrites();
  const inspections = new Map<string, McpServerEntry>();
  const authObservations = new Map<string, NonNullable<McpServerEntry['authState']>>();
  for (const { key, state } of deps.authObservationStore?.load() ?? []) authObservations.set(key, state);
  let activeProbes = 0;

  function nativeConfiguration(entry: McpServerEntry): Record<string, unknown> {
    return entry.catalog ? {} : entry.spec;
  }

  function authKey(id: string, entry: McpServerEntry, canonical: string, launch: Record<string, unknown>): string {
    return mcpObservationKey(id, canonical, {
      configuration: { ...nativeConfiguration(entry), type: canonical, enabled: entry.enabled !== false },
      command: launch.command, cwd: launch.cwd,
    });
  }

  function authenticationCapability(state: NonNullable<McpServerEntry['authState']>['state']) {
    const required = state === 'required' || state === 'expired';
    return {
      supported: !!deps.authenticationJobs && state !== 'ready',
      reason: !deps.authenticationJobs ? 'Native authentication continuation is not available in this manager.'
        : required
          ? 'Continue explicitly to keep the same native proxy running for authentication and tool discovery. This does not guarantee access to individual tools.'
          : state === 'unknown'
            ? 'Connect explicitly with a longer-lived native process and authenticate if needed. Authentication state is unknown; no missing or expired credentials are inferred.'
            : 'Tool inventory already succeeded for this configuration. Authorization of individual tools has not been verified.',
    };
  }

  function category(id: string): McpCategory {
    if (!deps.enabled()) throw new ValidationError('MCP server management is disabled');
    const found = deps.categories.find((item) => item.info.id === id);
    if (!found) throw new NotFoundError(`Unknown MCP category '${id}'`);
    return found;
  }

  function studioEntry(): McpServerEntry {
    return {
      name: deps.studio.name, displayName: 'AI Project Studio', source: 'App-owned launch configuration',
      scope: 'app', enabled: true, spec: deps.studio.spec,
      origin: 'app', providerLabel: 'This app',
      capabilities: capabilities(Object.fromEntries(OPERATIONS.map((op) => [op, op === 'tools' ? null : LIFECYCLE_NOTICE]))),
      tools: deps.studio.tools,
      toolDiscovery: { status: 'skipped', message: 'App tool inventory; no connection probe was performed. Check status explicitly to verify the bridge.', output: [] },
    };
  }

  async function getServers(id: string): Promise<ProviderMcpConfig> {
    const def = category(id);
    if (id === 'studio') {
      const server = studioEntry();
      return { providerId: id, configPath: server.source!, exists: true, servers: [server], capabilities: server.capabilities, notices: [LIFECYCLE_NOTICE] };
    }
    if (def.unavailableReason) {
      return { providerId: id, configPath: def.sources[0].path, exists: false, servers: [],
        capabilities: capabilities(Object.fromEntries(OPERATIONS.map((op) => [op, def.unavailableReason]))),
        notices: [def.unavailableReason] };
    }
    const servers: McpServerEntry[] = [];
    const notices = [...def.notices];
    const catalog = def.catalog?.();
    const reads = new Map<string, Promise<McpConfigDocument | null>>();
    let sources = def.sources;
    if (def.exclusiveSource) {
      const source = def.exclusiveSource;
      try {
        const document = await source.store.read(source.path);
        if (document !== null) {
          sources = [source];
          reads.set(source.path, Promise.resolve(document));
          notices.push('Exclusive managed MCP configuration is present. Ordinary user/project configuration is suppressed and cannot be edited here.');
        }
      } catch {
        return { providerId: id, configPath: source.path, exists: false, servers: [], capabilities: capabilities({}),
          notices: ['Exclusive managed configuration cannot be read. Ordinary source edits are blocked until its policy is verified.'] };
      }
    }
    let disabled = new Set<string>();
    if (def.disabledNamesSource) {
      const source = def.disabledNamesSource;
      try {
        const read = source.store.read(source.path);
        reads.set(source.path, read);
        disabled = disabledNames(await read, source.segments);
      } catch {
        return { providerId: id, configPath: source.path, exists: false, servers: [], capabilities: capabilities({}),
          notices: ['Native disabled-server settings cannot be read reliably. Use the native CLI to inspect and repair configuration.'] };
      }
    }
    let exists = false;
    let primaryAvailable = true;
    let globalAvailable = false;
    let resolvedBuiltinsAvailable = false;
    for (const source of sources) {
      try {
        let read = reads.get(source.path);
        if (!read) { read = source.store.read(source.path); reads.set(source.path, read); }
        const document = await read;
        exists ||= document !== null;
        const map = serverMap(document ?? {}, source, false);
        for (const [name, raw] of Object.entries(map)) {
          const entry = entryFor(source, name, raw);
          if (disabled.has(name)) {
            entry.enabled = false;
            entry.capabilities!.tools = entry.capabilities!.restart = {
              supported: false, reason: 'This server is disabled in the native project settings. Enable it in the CLI before probing.',
            };
          }
          if (name === deps.studio.name) {
            entry.origin = 'app';
            entry.providerLabel = 'This app';
            delete entry.builtinName;
            entry.spec = deps.studio.spec;
            entry.capabilities = studioEntry().capabilities;
            entry.tools = deps.studio.tools;
            entry.toolDiscovery = studioEntry().toolDiscovery;
          }
          if (entry.origin === 'agency-built-in' && source.builtinScope) {
            entry.configurationSources = [{
              kind: source.builtinScope, source: source.path, scope: source.scope,
              spec: entry.spec, enabled: entry.enabled,
            }];
          }
          servers.push(entry);
        }
        if (source === def.builtinSetup?.source) globalAvailable = true;
        if (source.builtinScope === 'resolved') resolvedBuiltinsAvailable = true;
        if (document === null) notices.push(source.missingNotice ??
          `${source.scope}: configuration file does not exist. CLI installation and active connections have not been checked.`);
      } catch {
        if (source === sources[0]) primaryAvailable = false;
        notices.push(`${source.scope}: configuration is unavailable or invalid. No data was replaced. Use the native CLI/configuration to inspect this source.`);
      }
    }
    if (catalog) {
      const available = structuredClone(await catalog);
      for (const entry of servers) {
        if (entry.origin !== 'agency-built-in' || !entry.builtinName) continue;
        const canonical = typeof entry.spec.type === 'string' ? entry.spec.type : entry.builtinName;
        const option = available.servers.find((candidate) => candidate.builtinName === canonical);
        if (option?.description) entry.description = option.description;
      }
      if (def.builtinSetup && !globalAvailable) {
        for (const entry of available.servers) {
          entry.capabilities!.add = {
            supported: false,
            reason: 'Global Agency configuration is unavailable or invalid. Setup is blocked to avoid overwriting unreadable configuration. Resolve the global-source notice and refresh; no setup command was attempted.',
          };
        }
      }
      if (globalAvailable) {
        for (const entry of available.servers) {
          entry.capabilities!.add = { supported: true, reason: 'Configure this built-in in Agency global configuration using the app. Optional arguments are passed to the native --mcp setter. Existing sessions are not reloaded or authenticated; workspace overrides may still take precedence.' };
        }
        for (const entry of servers) {
          if (entry.name.startsWith(`${def.builtinSetup!.source.id}:`) &&
              available.servers.some((option) => option.builtinName === entry.builtinName)) {
            entry.capabilities!.edit = { supported: true, reason: 'Configure this global built-in with native arguments using the dedicated setup form, not the raw JSON editor. Supply all required parameters for the replacement configuration. Existing sessions are unchanged.' };
          }
        }
      }
      const configuredBuiltinNames = new Set(servers.filter((entry) =>
        def.sources.some((source) => source.builtin && entry.name.startsWith(`${source.id}:`)),
      ).map((entry) => entry.displayName));
      servers.push(...available.servers.filter((entry) => !configuredBuiltinNames.has(entry.displayName)));
      notices.push(...available.notices);
      if (def.builtinRuntime) {
        for (const entry of servers) {
          if (!entry.builtinName || (entry.catalog && (!globalAvailable || !resolvedBuiltinsAvailable))) continue;
          const runtime = def.builtinRuntime.resolve(entry.builtinName, nativeConfiguration(entry));
          const canonical = runtime.supported ? runtime.canonicalName ?? entry.builtinName : entry.builtinName;
          const installed = available.servers.some((option) => option.builtinName === canonical);
          if (runtime.supported) {
            entry.commandPreview = mcpCommandPreview(runtime.launch);
            entry.authState = structuredClone(authObservations.get(authKey(id, entry, canonical, runtime.launch)) ?? {
              state: 'unknown', checkedAt: null, message: 'Not checked. Configuration does not establish authentication state.',
            });
            entry.authentication = authenticationCapability(entry.authState.state);
          }
          entry.capabilities!.tools = installed && entry.enabled !== false && runtime.supported
            ? { supported: true, reason: `${entry.catalog ? 'Explicit default-options probe; this does not configure the built-in. ' : ''}Native startup may initiate its own sign-in flow; a short probe will close its process. Tool inventory does not establish authorization of individual tools.` }
            : { supported: false, reason: !installed ? 'This built-in is not in the installed public catalog.'
              : entry.enabled === false ? 'This native built-in is disabled.'
                : (runtime as { supported: false; reason: string }).reason };
        }
      }
    }
    const logicalServers = mergeBuiltinSources(servers);
    for (const entry of logicalServers) {
      if (entry.authentication && !entry.capabilities!.tools.supported) {
        entry.authentication = { ...entry.capabilities!.tools };
      }
    }
    return {
      providerId: id, configPath: sources[0].path, exists, servers: logicalServers,
      capabilities: primaryAvailable ? sourceCapabilities(sources[0]) :
        capabilities(Object.fromEntries(OPERATIONS.map((op) => [op, 'The primary configuration source is unavailable or invalid. Repair it before editing.']))),
      notices,
    };
  }

  async function locate(id: string, name: string): Promise<Located> {
    const def = category(id);
    const config = await getServers(id);
    const entry = config.servers.find((item) => item.name === name);
    if (!entry) throw new NotFoundError(`MCP server '${name}' is unavailable in '${id}'`);
    const source = [...def.sources, ...(def.exclusiveSource ? [def.exclusiveSource] : [])]
      .find((item) => name.startsWith(`${item.id}:`));
    // Studio has no editable file source; capability checks happen before using it.
    return { source: source!, rawName: entry.displayName!, entry };
  }

  function requireCapability(entry: McpServerEntry, operation: McpOperation): void {
    const cap = entry.capabilities![operation];
    if (!cap.supported) throw new ValidationError(cap.reason!);
  }

  async function write<T>(source: McpCategorySource, action: (document: McpConfigDocument) => T): Promise<T> {
    return writes.run(source.path, async () => {
      const document = await source.store.read(source.path) ?? {};
      const result = action(document);
      await source.store.write(source.path, document);
      inspections.clear();
      return result;
    });
  }

  async function mutate(id: string, name: string, operation: McpOperation, change?: (raw: unknown, source: McpCategorySource) => unknown): Promise<ProviderMcpConfig> {
    const target = await locate(id, name);
    requireCapability(target.entry, operation);
    await write(target.source, (document) => {
      const map = serverMap(document, target.source, false);
      if (!Object.hasOwn(map, target.rawName)) throw new NotFoundError('The server was removed while editing. Refresh the source.');
      requireCapability(entryFor(target.source, target.rawName, map[target.rawName]), operation);
      if (operation === 'remove') delete map[target.rawName];
      else map[target.rawName] = change!(map[target.rawName], target.source);
    });
    return getServers(id);
  }

  function validateInput(input: McpServerInput, source: McpCategorySource): void {
    if (!object(input.spec)) throw new ValidationError('Server spec must be a JSON object.');
    for (const key of source.forbiddenSpecKeys ?? []) {
      if (Object.hasOwn(input.spec, key)) throw new ValidationError(`This source does not support the '${key}' server field. Use native CLI controls.`);
    }
  }

  async function inspectServer(id: string, name: string): Promise<McpServerEntry> {
    const { entry, source } = await locate(id, name);
    requireCapability(entry, 'tools');
    if (entry.origin === 'app') return entry;
    if (activeProbes >= deps.maxConcurrentProbes) throw new ValidationError('MCP probe capacity is busy. Wait for the current probes to finish.');
    activeProbes += 1;
    try {
      const runtime = entry.builtinName ? category(id).builtinRuntime!.resolve(entry.builtinName, nativeConfiguration(entry)) : undefined;
      if (runtime && !runtime.supported) throw new ValidationError(runtime.reason);
      const result = await deps.tools.inspect({
        serverName: entry.displayName!, spec: runtime?.launch ?? entry.spec, timeoutMs: deps.probeTimeoutMs,
      });
      const server = inspectedEntry(id, entry, source, result, !!runtime, runtime?.launch, runtime?.canonicalName);
      inspections.set(`${id}/${name}`, server);
      return server;
    } finally { activeProbes -= 1; }
  }

  function inspectedEntry(id: string, entry: McpServerEntry, source: McpCategorySource, raw: McpToolInspection, native: boolean, launch?: Record<string, unknown>, canonical?: string): McpServerEntry {
      const result = native ? nativeToolInspection(raw) : raw;
      if (native) {
        const state = observedMcpAuth(raw, deps.now().toISOString());
        const key = authKey(id, entry, canonical ?? entry.builtinName!, launch!);
        authObservations.delete(key);
        authObservations.set(key, structuredClone(state));
        deps.authObservationStore?.put(key, structuredClone(state));
        if (authObservations.size > deps.maxAuthObservations) {
          const evicted = authObservations.keys().next().value!;
          authObservations.delete(evicted);
          deps.authObservationStore?.delete(evicted);
        }
        entry = { ...entry, authState: state, commandPreview: mcpCommandPreview(launch!) };
      }
      const allow = !native && source.supportsToolAllowList ? entry.spec.tools : undefined;
      const filtered = Array.isArray(allow) && !allow.includes('*') ? allow : null;
      const server: McpServerEntry = {
        ...entry,
        tools: result.tools.map((tool) => ({ ...tool, enabled: filtered === null || filtered.includes(tool.name) })),
        toolDiscovery: { ...result, message: [PROBE_NOTICE, result.message].filter(Boolean).join(' '), output: [] },
        ...(native ? { authentication: authenticationCapability(entry.authState!.state) } : {}),
      };
      return server;
  }

  function applyResult(config: ProviderMcpConfig, server: McpServerEntry, message: string): McpApplyResult {
    return { config, server, liveReloadedSessions: 0, liveReloadCommand: null, message };
  }

  return {
    listProviders: () => deps.categories.map((item) => ({
      ...item.info,
      capabilities: item.unavailableReason ? capabilities(Object.fromEntries(OPERATIONS.map((op) => [op, item.unavailableReason]))) :
        item.info.id === 'studio' ? studioEntry().capabilities : sourceCapabilities(item.sources[0]),
    })),
    getServers,
    async getServerOptions(id, name) {
      const def = category(id);
      const { entry } = await locate(id, name);
      if (!def.options || !entry.builtinName) return {
        command: '', options: [], examples: [], cachedAt: null, stale: false,
        message: 'Server-specific native suggestions are available only for Agency built-ins.',
      };
      const canonical = !entry.catalog && typeof entry.spec.type === 'string' ? entry.spec.type : entry.builtinName;
      return def.options.get(canonical);
    },
    async startAuthentication(id, name) {
      const def = category(id);
      if (!deps.authenticationJobs || !def.builtinRuntime) throw new ValidationError('Native authentication continuation is not supported for this category.');
      const { entry, source } = await locate(id, name);
      requireCapability(entry, 'tools');
      if (!entry.builtinName) {
        throw new ValidationError('Run an explicit native tools check first. Authentication can be continued only for its observed challenge and unchanged configuration.');
      }
      const runtime = def.builtinRuntime.resolve(entry.builtinName, nativeConfiguration(entry));
      if (!runtime.supported) throw new ValidationError(runtime.reason);
      const observation = authObservations.get(authKey(id, entry, runtime.canonicalName ?? entry.builtinName, runtime.launch));
      if (!authenticationCapability(observation?.state ?? 'unknown').supported) {
        throw new ValidationError('Tool inventory already succeeded for this configuration. Run a new explicit tools check if authentication may have changed.');
      }
      return deps.authenticationJobs.start({
        owner: `${id}/${name}`, serverName: name,
        run: async (signal, onProgress) => {
          const result = await deps.tools.inspect({
            serverName: entry.displayName!, spec: runtime.launch,
            timeoutMs: deps.authenticationTimeoutMs ?? deps.probeTimeoutMs,
            signal, onProgress,
          });
          const server = signal.aborted ? entry : inspectedEntry(id, entry, source, result, true, runtime.launch, runtime.canonicalName);
          if (!signal.aborted) inspections.set(`${id}/${name}`, server);
          return server;
        },
      });
    },
    async authenticationStatus(id, name, jobId) {
      category(id);
      if (!deps.authenticationJobs) throw new ValidationError('Native authentication jobs are not supported.');
      return deps.authenticationJobs.get(`${id}/${name}`, jobId);
    },
    async cancelAuthentication(id, name, jobId) {
      category(id);
      if (!deps.authenticationJobs) throw new ValidationError('Native authentication jobs are not supported.');
      return deps.authenticationJobs.cancel(`${id}/${name}`, jobId);
    },
    async configureBuiltin(id, name, input) {
      const def = category(id);
      if (!def.builtinSetup) throw new ValidationError('Built-in configuration is not supported for this category.');
      const { entry, source } = await locate(id, name);
      if (!entry.builtinName || (!entry.catalog && source !== def.builtinSetup.source)) {
        throw new ValidationError('Only an available catalog built-in or its explicitly scoped global entry can be configured. Resolved and inherited entries are read-only.');
      }
      requireCapability(entry, entry.catalog ? 'add' : 'edit');
      await def.builtinSetup.manager.configure(entry.builtinName, input.arguments, entry.catalog ? 'add' : 'edit');
      const config = await getServers(id);
      config.notices = [...config.notices!, 'Agency global built-in persistence was verified after setup. Existing sessions were not reloaded or authenticated. Resolved/workspace overrides may differ from this global declaration.'];
      return config;
    },
    async putServer(id, input) {
      const def = category(id);
      if (id !== 'studio' && input.name === deps.studio.name) throw new ValidationError(LIFECYCLE_NOTICE);
      if (input.name.includes(':') || id === 'studio') {
        return mutate(id, input.name, 'edit', (_raw, source) => {
          validateInput(input, source);
          return input.spec;
        });
      }
      const available = await getServers(id);
      if (!available.capabilities!.add.supported) throw new ValidationError(available.capabilities!.add.reason!);
      if (!/^[A-Za-z0-9_.-]+$/.test(input.name) || ['__proto__', 'prototype', 'constructor'].includes(input.name)) {
        throw new ValidationError('Use a nonempty server name containing only letters, numbers, dots, underscores and hyphens.');
      }
      const source = def.sources[0];
      validateInput(input, source);
      await write(source, (document) => {
        const map = serverMap(document, source, true);
        if (Object.hasOwn(map, input.name)) throw new ValidationError('A server with this name already exists. Edit its scoped entry instead.');
        map[input.name] = input.spec;
      });
      return getServers(id);
    },
    removeServer: (id, name) => mutate(id, name, 'remove'),
    setServerEnabled: async (id, name, enabled) => {
      if (typeof enabled !== 'boolean') throw new ValidationError('enabled must be a boolean.');
      return mutate(id, name, 'toggle', (raw) => ({ ...(object(raw) ? raw : {}), enabled }));
    },
    inspectServer,
    async setToolEnabled(id, input) {
      if (typeof input.enabled !== 'boolean' || !input.toolName.trim()) throw new ValidationError('A tool name and boolean enabled value are required.');
      const target = await locate(id, input.serverName);
      requireCapability(target.entry, 'toolToggle');
      const cached = inspections.get(`${id}/${input.serverName}`);
      if (!cached?.tools || cached.toolDiscovery?.status !== 'ok') {
        throw new ValidationError('Inspect tools successfully before changing the allow-list.');
      }
      if (JSON.stringify(cached.spec) !== JSON.stringify(target.entry.spec)) {
        throw new ValidationError('The server configuration changed since inspection. Inspect its tools again.');
      }
      if (!cached.tools.some((tool) => tool.name === input.toolName)) throw new ValidationError('The tool was not returned by the last inspection.');
      const config = await mutate(id, input.serverName, 'toolToggle', (raw) => {
        const spec = unwrapServerSpec(raw as Record<string, unknown>);
        if (JSON.stringify(spec) !== JSON.stringify(cached.spec)) {
          throw new ValidationError('The server configuration changed while saving. Inspect its tools again.');
        }
        const allow = spec.tools;
        const names = new Set(Array.isArray(allow) && !allow.includes('*') ? allow : cached.tools!.map((tool) => tool.name));
        if (input.enabled) names.add(input.toolName); else names.delete(input.toolName);
        return { ...spec, tools: [...names] };
      });
      return applyResult(config, config.servers.find((entry) => entry.name === input.serverName)!, 'Saved the native tool allow-list. No running CLI session was reloaded.');
    },
    async restartServer(id, name) {
      const { entry } = await locate(id, name);
      requireCapability(entry, 'restart');
      const server = await inspectServer(id, name);
      return applyResult(await getServers(id), server, PROBE_NOTICE);
    },
    async serverStatus(id, name) {
      const { entry } = await locate(id, name);
      if ((id === 'studio' || entry.displayName === deps.studio.name) && deps.studio.probe) {
        if (activeProbes >= deps.maxConcurrentProbes) throw new ValidationError('MCP probe capacity is busy. Wait for the current probes to finish.');
        activeProbes += 1;
        try { return { ...await deps.studio.probe(), name }; }
        finally { activeProbes -= 1; }
      }
      const previous = inspections.get(`${id}/${name}`);
      const cached = previous && JSON.stringify(previous.spec) === JSON.stringify(entry.spec) ? previous : undefined;
      return {
        name,
        status: entry.enabled === false ? 'disabled' : !cached ? 'unsupported' :
          cached.toolDiscovery!.status === 'ok' ? 'connected' : cached.toolDiscovery!.authRequired ? 'auth-required' : 'error',
        toolCount: cached?.tools?.length ?? 0,
        authRequired: cached?.toolDiscovery?.authRequired ?? false,
        authUrl: cached?.toolDiscovery?.authUrl ?? null,
        message: cached ? cached.toolDiscovery!.message : 'No probe has been requested. Configuration presence does not establish a live CLI connection.',
      };
    },
  };
}
