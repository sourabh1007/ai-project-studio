# Adding a new CLI tool (provider)

The app is intentionally **not** coupled to a particular CLI. Adapters expose
supported capabilities behind the provider interface; registration does not
promise every interactive, headless, agent, quota or history capability.
Agency and Claude support IDE-launched automation using their unmodified native
CLI configuration and permissions. Zero-MCP isolation is a separate, optional
execution policy, not a prerequisite for native automation.

On Windows, a discovered npm `.cmd` launcher is not a native executable.
Copilot command resolution uses the official npm package's verified platform
entry point (nested or hoisted, x64 or ARM64), falling back to its verified Node
loader when necessary. Interactive sessions, cold/background turns, warm ACP
pools and model-catalog probes share that resolution. Agency prioritizes a
native CLI on PATH, excludes the forwarding VS Code shim, and can recover an
npm-only installation by prepending its platform binary directory in the child
environment. This changes neither the global PATH nor CLI permissions, and
never feeds prompt text through `cmd.exe` or blindly retries dispatched work.

## The contract

Implement `IAIProvider` (`backend/src/provider/provider-contract.ts`). The essential surface:

| Member | Purpose |
| --- | --- |
| `id` | Unique provider id (its config namespace). |
| `listModels()` | Models the tool exposes (for the model picker / resolver). |
| `startSession(spec)` | Launch a one-shot (non-interactive) run and return a running session handle. |
| `buildInteractiveCommand(spec)` | Return `{ command, args, env }` for the interactive TUI the terminal will spawn in a PTY. |
| `buildWarmCommand(spec, extraArgs, disabledMcpServers)` *(optional)* | Return the provider-owned persistent ACP command/env and advertise `warmTransport: 'acp'`. |
| `listImportableSessions()` *(optional)* | Expose past provider-native sessions for import. |

Look at the three existing adapters as templates:
- `provider/copilot-adapter/` — `copilot-provider.ts`, `copilot-cmd-builder.ts`, `copilot-env-mapper.ts`, `copilot-model-lister.ts`.
- `provider/agency-adapter/` — `agency-provider.ts` (wraps another CLI via a passthrough prefix and reuses Copilot's interactive args).
- `provider/claude-adapter/` — native Claude Code **v2**, native history/usage,
  native sign-in and unavailable plan-quota/AIC handling. Studio invokes the
  user's unmodified CLI; it never collects or intermediates subscription tokens.
  The optional isolated programmatic profile requires supported API/cloud
  credentials instead.

## Steps

1. **Create the adapter** under `provider/<tool>-adapter/`:
   - A `config.ts` trio (`<TOOL>_NAMESPACE`, schema, defaults) for its executable path, flags, etc.
   - A `<tool>-provider.ts` implementing `IAIProvider`.
   - Small pure helpers (command builder, env mapper, model lister) so logic stays unit-testable.
2. **Wire it in `backend/src/main.ts`:** register config and its descriptor,
   construct/register the provider, and connect installation detection,
   readiness/health and execution availability. Advertise only supported
   capabilities; registration alone is not complete onboarding.
3. **Usage ingestion:** if the tool emits telemetry in a different location/format, add a reader under `provider/cli-store/` (or a new store) and feed it through `usage/` — keep `usage-recorder`/`credit`/`aggregation` unchanged by conforming to the existing `UsageEvent` shape.
4. **Tests:** unit-test the command builder, env mapper, model lister, and provider (mirror the Copilot/Agency tests). Maintain 100% backend coverage.

History/import is capability-driven: Agency and Claude expose native import
hooks, but not every registered adapter supplies a standalone import list.
Keep history and usage readers keyed by the persisted provider, including after
a global CLI switch.

## Generic hooks — avoid tool-specific coupling

### Command configuration

Settings → Tools & CLIs lists module-owned command configuration. Keep required
session, JSON, ACP, MCP-isolation and no-tools flags in pure builders; optional
argv must use `provider/command-options.ts` validation, including direct builder
calls. Optional flags cannot override those requirements through aliases,
`--flag=value`, control characters or another authentication operation.

Copilot and Agency have shared `extraArgs` plus mode-specific `interactiveArgs`
and `headlessArgs`. Their `commandProfile` owns version argv, usage-panel input
and optional `liveReloadCommand` (defaults to `/restart`). `loginCommand` is
only a native-login display hint, not an executable authentication feature.
Claude keeps its native version/auth operation prefixes, safe optional suffixes
and separate interactive/headless argv. Unsupported quota surfaces remain
unavailable rather than launching a different provider.

ACP warm workers use `meta.warmPool.extraArgs`; the separate model-catalog probe
uses `meta.warmPool.modelCatalogExtraArgs`. Both retain app-owned ACP flags.
Quota probes use `planUsage.extraArgs` while retaining model/session identity.

Installer profiles configure launcher paths, not package IDs or bootstrap
scripts: `agencyBootstrap` and `copilotBootstrap` own `windowsExecutable` and
`posixExecutable`; `selfHeal` owns `wingetExecutable` and `brewExecutable`.
Claude owns `installWindowsExecutable` and `installPosixExecutable`; legacy
`installWindowsCommand`/`installPosixCommand` remain compatible but are not
advertised as safe optional argv. Installer configuration never grants consent
or authorizes execution; keep existing consent and execution-admission checks.
The user must explicitly select **Install and use**. Copilot installs through
its official npm package, Agency through its internal InstallTool bootstrap,
and Claude through its supported configured platform installer. Bootstrap
installation/version deadlines belong to their module config; detection must
use the configured executable and version argv, not a hardcoded alternate CLI.

### Headless execution policy

`mcp.headlessPolicies` is an editable provider-to-policy map in Settings.
Defaults are `copilot: isolated`, `agency: native`, `claude: native`; unlisted
providers default to `isolated`. Restart after changing this setting.
Native mode preserves the CLI's settings, plugins, MCP configuration, sign-in
and administrator policies. Explicitly invoking an AI feature may start native
MCP servers or request native sign-in. Studio does not rewrite managed policy,
automatically submit work when selecting a CLI, or collect native credentials.

Text-only turns retain explicit no-tools restrictions in both modes. Normal
tool-enabled runs retain configured permission flags; native mode does not add
permission-bypass flags. Session identity and JSON protocol flags remain
app-owned. Isolation preflight is asynchronous, bounded and cancellable; no
synchronous repository walk belongs on the API thread.

- **Copilot (isolated by default):** preflight uses the installed CLI's read-only `mcp list --json`
  effective inventory for the actual working directory and environment. This
  supports native settings syntax, including comments, and enumerates user,
  workspace, plugin and built-in sources without guessing from plugin directories.
  Every returned server is disabled independently of native trust decisions.
  Missing, malformed, oversized or failed inventories fail closed. Windows npm
  shims dispatch through the official package's declared Node entry point, not
  a command shell; prompt arguments are never interpolated into shell strings.
- **Agency (native by default):** metasessions use the real Agency executable,
  normal native overlays and the Copilot JSON protocol. Optional `isolated`
  mode refuses automated launches because native overlays cannot be verified
  as completely suppressed; plain Copilot listing is not sufficient. Switch
  to native mode or another provider rather than bypass administrator policy.
- **Claude (native by default):** prompt-mode turns preserve native MCP and
  authentication. Text-only turns disable built-in and MCP model tools.
  Optional `isolated` mode adds strict-empty MCP configuration, requires
  supported API/cloud credentials, and checks for conflicting managed MCP
  policy before launch. Managed policy is never removed or overridden.

Installation, authentication and execution policy are separate requirements.
Summaries, planners and agents surface real launch failures rather than claim
successful automated work.
Provider entries from `/providers/bootstrap`, `/providers` and selection/switch
responses can expose `automation: { supported: boolean, reason: string | null }`.
Consumers use this generic readiness metadata to disable automated actions and
show the reason/another-CLI guidance while preserving interactive terminals,
Settings and history. Baseline readiness is not final launch authorization:
Copilot rechecks the actual session working directory/ancestors before execution.

The configurable `providerFeatures.features` catalogue owns feature IDs, labels
and requirements (`installed-cli`, `automation`, or neither for manual features).
Provider responses include resolved per-feature `available`, `setup-required`,
`checking`, `integration-required` or `unsupported` states. Missing installation
takes precedence over integration readiness. An unimplemented Studio integration
must use `integration-required`, not claim the native CLI lacks automation.
Adding a future feature using those execution
requirements needs no per-CLI UI changes. Configuration never grants execution
permission. `mcp.headlessInventoryMaxBytes` and `mcp.readinessCacheMs` bound native
inventory output and baseline caching; launch-time checks never use the cache.
Automatic model-catalog probes retain isolated startup checks and use the
configured model list when native overlays cannot be verified. Enabled
tool-free warm workers use the selected provider's headless policy. Agency
workers preserve native MCP/sign-in and initialize their native session before
becoming idle; explicitly enabling prewarming may start native MCP servers.
Strict warm reviews never fall back to cold execution.
Agency's informational Copilot passthrough skips Agency's real MCP/plugin setup,
so its plain Copilot listing cannot certify isolated Agency launches.
Claude's native version/sign-in checks run after explicit selection; readiness
must wait for those checks and preserve their failure reasons, rather than
infer missing credentials for an unselected provider or readiness from API
environment variables alone.

### History and accounting

History is routed by the **persisted session provider**, not the currently
selected CLI. Compose `createProviderHistoryReader({ sessions, readers })` with
a provider-keyed map of `CopilotHistoryReader`-shaped readers; missing readers
return no history rather than querying another vendor's store.

Compose `createProviderUsageRouter({ sessions, sources })` for every background
capture surface, including late metasession reconciliation. Its
`readUsagePage(sessionId, persistedContext, cursor, limit)` rejects attribution
mismatches. Use `sourceId(session.provider)` when constructing the existing
durable `createCliUsageTailer`.

For native log providers, `createProviderUsageReader` normalizes bounded cached
pages into the same capture protocol. Parse and discover logs in bounded,
cancellable background workers; API readers only access cached snapshots.
Capture identities include provider, native session, scope and message ID, so
duplicate blocks, subagents and resumed sessions do not depend on log position.
Native attribution cannot be changed by later corrections.

`UsageEvent.cost`, `nanoAiu`, and persisted `credits` are nullable: **unavailable
is not zero**. Never derive native AIC from tokens or USD. Explicit
`chargeProvenance` and `chargeUnit` describe native billing; `usdEstimate` is
separate. Cumulative session USD results use one replaceable charge-only
`session-charge-estimate` observation per native session, with zero inference
tokens. Repeated/resumed result snapshots replace that observation rather than
adding prior spend again. Mixed totals remain null if any native charge is
missing; available estimates remain separately labelled USD estimates.

Native usage samples define `inputTokens` as uncached input. Optional
`cacheReadTokens` and `cacheWriteTokens` are disjoint reported categories,
added once to canonical input totals. Cumulative session-result token counts
are not added to message-level input, including their cache counts.

The accounting migration atomically rebuilds the usage and retained-usage
tables with nullable native amounts. Existing provider identities and numerical
amounts (including reported zero) are copied unchanged. Historical native
charges receive reported/AIC provenance; no historical provider is relabelled.

When adding user-facing behavior (session UX, "update available" banners, health checks, etc.), put it behind a **generic capability** on the provider/registry, not an `if (tool === 'agency')` branch. Preferred pattern:

- Add an optional capability method to `IAIProvider` (e.g. `checkForUpdate()`, `readiness()`), default it in a base/no-op, and let each adapter opt in.
- The UI/API consumes the capability generically via the registry, so any tool can supply it.

This keeps the IDE independent of any single CLI while still surfacing rich, tool-specific experiences when a provider offers them.

Providers with native command-line context delivery declare
`capabilities.interactiveBootstrap: 'command'`. The terminal manager then supplies
`SessionSpec.instructions` and the persisted-session `resume` flag to the adapter,
without writing Copilot instruction files or typing the bootstrap into the PTY.
Initial task prompts and confirmed recovery replay requests retain their normal
seeding behavior.

## Active-provider execution admission

Provider registration does not authorize execution. `provider/active-provider.ts`
owns the single selected CLI, persisted under `providerSelection.providerId`.
A missing or no-longer-eligible choice requires explicit setup; configured
defaults must not silently authorize a run.

Inject the same `ProviderExecutionPolicy` into the resolver, session launcher,
terminal manager, and every background process owner. Acquire a lease
synchronously **before** model lookup, bootstrap, queuing, or process launch.
Retain it until native exit is confirmed (a requested kill or timeout is not
confirmation). Release failed preparations that never started a native process.
Warm workers and probes must also appear as leases or `externalBlockers`;
historical reads do not acquire execution admission.

`POST /providers/selection` accepts `{ providerId }`. It validates eligibility
and checks blockers synchronously, persists successfully, and only then changes
the active provider. HTTP 409 conflicts return
`{ error: { kind, message, blockers: [{ kind, id, label }] } }`; read
`error.blockers`, not internal `ConflictError.details`. No work is
silently killed. Bootstrap adds `selectionRequired`, `revision`, and `blockers`.
Provider lists, bootstrap, and model catalogs apply the same availability policy.
Agency appears only when the internal-network probe succeeds. The bounded TCP
probe sends no credentials or HTTP data; `agencyBootstrap.microsoftNetworkHost`,
`microsoftNetworkPort`, `microsoftNetworkTimeoutMs`, and
`microsoftNetworkRefreshMs` configure its target and refresh cadence (restart
after changing the cadence). Detection failures hide Agency. Sign-in, email
domains, and the deprecated `providerSelection.allowInternalAgency` preference
do not bypass this policy. Visibility never verifies authorization or selects
or launches the CLI.
The installed Agency CLI remains responsible for its own authentication.
Copilot and Claude work without Agency or internal credentials.

Selection also accepts an optional `remember` boolean (legacy callers default
to `true`). Startup's **Remember me** checkbox is initially unchecked. An
unchecked choice remains active for the backend's lifetime but clears any
previous saved choice, so the next startup asks again. Legacy persisted
provider selections remain remembered.

`POST /providers/switch` requires `{ providerId, remember, expectedRevision }`.
After explicit user confirmation, it fences execution admission, drains
interactive terminals and idle background workers within a bounded deadline,
then verifies every lease has released before persisting the new choice.
Running background AI requests, stale revisions, unconfirmed native exits, or
persistence failures refuse the switch without changing provider identity.
Stopping an interactive terminal preserves its transcript and session record;
it never deletes a session. The legacy `PUT /providers/preferences` contract
remains available to custom hosts with an injected preference handler; the
desktop composition root no longer configures that manual opt-in endpoint.

Providers may expose `prepareInteractiveSession()` to await their non-billable
native readiness checks before command construction. The terminal retains its
execution lease while awaiting readiness; startup and switching never race the
Claude version/authentication probes.

## Checklist
- [ ] `IAIProvider` fully implemented.
- [ ] Config namespace/schema/defaults added and registered.
- [ ] Provider registered in `main.ts`.
- [ ] Telemetry conforms to `UsageEvent` (or a new reader added) so analytics work.
- [ ] Unit tests added; backend coverage stays at 100%.
- [ ] No tool-specific branching in core/UI — behavior flows through generic hooks.
