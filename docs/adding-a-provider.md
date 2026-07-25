# Adding a new CLI tool (provider)

The app is intentionally **not** coupled to Copilot or Agency. Any AI coding CLI can be integrated behind the provider interface so that features, sessions, terminal, usage, and analytics work unchanged.

## The contract

Implement `IAIProvider` (`backend/src/provider/provider-contract.ts`). The essential surface:

| Member | Purpose |
| --- | --- |
| `id` | Unique provider id (its config namespace). |
| `listModels()` | Models the tool exposes (for the model picker / resolver). |
| `startSession(spec)` | Launch a one-shot (non-interactive) run and return a running session handle. |
| `buildInteractiveCommand(spec)` | Return `{ command, args, env }` for the interactive TUI the terminal will spawn in a PTY. |
| `listImportableSessions()` *(optional)* | Expose past provider-native sessions for import. |

Look at the two existing adapters as templates:
- `provider/copilot-adapter/` — `copilot-provider.ts`, `copilot-cmd-builder.ts`, `copilot-env-mapper.ts`, `copilot-model-lister.ts`.
- `provider/agency-adapter/` — `agency-provider.ts` (wraps another CLI via a passthrough prefix and reuses Copilot's interactive args).

## Steps

1. **Create the adapter** under `provider/<tool>-adapter/`:
   - A `config.ts` trio (`<TOOL>_NAMESPACE`, schema, defaults) for its executable path, flags, etc.
   - A `<tool>-provider.ts` implementing `IAIProvider`.
   - Small pure helpers (command builder, env mapper, model lister) so logic stays unit-testable.
2. **Wire it in `backend/src/main.ts`:** register the config namespace, construct the provider, and `registry.register(<tool>Provider)`.
3. **Usage ingestion:** if the tool emits telemetry in a different location/format, add a reader under `provider/cli-store/` (or a new store) and feed it through `usage/` — keep `usage-recorder`/`credit`/`aggregation` unchanged by conforming to the existing `UsageEvent` shape.
4. **Tests:** unit-test the command builder, env mapper, model lister, and provider (mirror the Copilot/Agency tests). Maintain 100% backend coverage.

## Generic hooks — avoid tool-specific coupling

When adding user-facing behavior (session UX, "update available" banners, health checks, etc.), put it behind a **generic capability** on the provider/registry, not an `if (tool === 'agency')` branch. Preferred pattern:

- Add an optional capability method to `IAIProvider` (e.g. `checkForUpdate()`, `readiness()`), default it in a base/no-op, and let each adapter opt in.
- The UI/API consumes the capability generically via the registry, so any tool can supply it.

This keeps the IDE independent of any single CLI while still surfacing rich, tool-specific experiences when a provider offers them.

## Checklist
- [ ] `IAIProvider` fully implemented.
- [ ] Config namespace/schema/defaults added and registered.
- [ ] Provider registered in `main.ts`.
- [ ] Telemetry conforms to `UsageEvent` (or a new reader added) so analytics work.
- [ ] Unit tests added; backend coverage stays at 100%.
- [ ] No tool-specific branching in core/UI — behavior flows through generic hooks.
