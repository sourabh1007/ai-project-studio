# Integration qualification

This matrix maps the app's user-facing capability groups to executable tests.
Unit and component tests still cover individual branches; the suites below prove
that real services, persistence, transports, and renderer composition cooperate.
External cloud services and installed AI CLIs are replaced with deterministic
ports unless the row explicitly names a native smoke test.

## Capability matrix

| Capability group | Integration coverage |
| --- | --- |
| Repository, feature, and nested-feature organization | `backend/src/integration/workspace-session.integration.test.ts` uses real SQLite repositories and services to create repositories/features, persist nested placement, and reject cyclic moves. |
| Sub-categories and session movement | `backend/src/integration/workspace-session.integration.test.ts` moves sessions and whole sub-category trees between persisted features while preserving placement. Renderer drag behavior is covered by `ui/src/features/workspace/feature-tree.test.tsx` and move-target rules by `ui/src/lib/feature-move-targets.test.ts`. |
| Shared context, prior-session memory, skills, and session bootstrap | `backend/src/integration/workspace-session.integration.test.ts` persists all inputs and verifies their ordered composition into launch context. Terminal delivery/reconnect is covered by `backend/src/terminal/terminal-ws-server.integration.test.ts` and `backend/src/terminal/node-pty-spawner.integration.test.ts`. |
| Automation checks, conditions, actions, reports, and subagents | `backend/src/integration/automation.integration.test.ts` uses real scheduling and SQLite persistence to run scheduled/manual checks, report and subagent actions, lifecycle controls, event publication, and cleanup. |
| Automation restart recovery | `backend/src/integration/automation.integration.test.ts` closes and reopens a file-backed workspace and verifies interrupted-run recovery without duplicate execution. Uncertainty acknowledgement has persistence coverage in `backend/src/automation/automation-scheduler.persistence.test.ts`. |
| PR feature, analysis, change graph, and cleanup | `backend/src/integration/pr-review-journey.integration.test.ts` creates and reopens a persisted PR feature, generates/stores its review and deterministic graph, records usage, and verifies deletion cleanup. Language analyzers have fixture tests in `backend/src/pr-review/*-analyzer.test.ts`. |
| Review Board | `backend/src/integration/pr-review-journey.integration.test.ts` discovers and analyzes multiple perspectives and proves the final retry escapes an unhealthy warm session through the forced-cold route. Renderer sign-off and identity handling are covered by `ui/src/features/review-board-page/*.test.*`. |
| PR comments, approval, and description export | `backend/src/integration/pr-review-journey.integration.test.ts` exercises the provider-neutral services through deterministic gateways. GitHub and Azure request/response contracts are covered by `backend/src/repo/*-pr-comments.test.ts`, `*-pr-approval.test.ts`, and `*-pr-description.test.ts`. |
| MCP server configuration and live reload | `backend/src/integration/mcp-management.integration.test.ts` persists real MCP configuration, discovers/toggles tools, restarts a server, and verifies reload of an active-session boundary. |
| Usage, credits, aggregation, detail, IDE AI, and SSE | `backend/src/integration/usage-meta.integration.test.ts` records normalized usage through real credit calculation and SQLite persistence, reads aggregate/detail state, and verifies live event forwarding. Renderer stream behavior is covered by `ui/src/hooks/use-usage-stream.test.tsx`. |
| Saved metasession operations | `backend/src/integration/usage-meta.integration.test.ts` persists an operation from creation through completion and reads its durable result. The renderer is covered by `ui/src/features/meta-operations/meta-operations-section.test.tsx`. |
| Shared warm metasession pool | `backend/src/integration/warm-pool.integration.test.ts` verifies warm routing, forced-cold routing, live resize, and status through deterministic ACP clients. Pool mechanics and admission failure paths remain exhaustively covered under `backend/src/meta/acp/`. |
| Settings composition, appearance persistence, diagnostics, retained images, and worktrees | `ui/src/integration/settings-diagnostics.integration.test.tsx` mounts real settings sections, navigates between them, persists appearance through remount, removes worktrees, and exercises crash evidence, copy, clear, and restart-retry flows. |
| Navigation, command palette, quick open, sidebar, and shortcuts | `ui/src/integration/app-navigation.integration.test.tsx` exercises the assembled `App`. |
| Electron preload capabilities | `desktop/tests/preload-integration.test.cjs` loads the real preload and exercises retained-image, diagnostics, clipboard, relaunch, update, and subscription-cleanup bridges. |
| Startup, shutdown, crash supervision, updates, packaging, and clipboard ownership | `desktop/tests/*.test.cjs` is the desktop lifecycle harness. `npm run test:desktop:smoke` rebuilds and launches the packaged app against an isolated synthetic backend and verifies startup/preload/backend identity and cooperative cleanup. |

## Qualification commands

Run these from the repository root:

```powershell
npm run test:coverage --workspace backend
npm run test:coverage --workspace ui
npm run test:desktop:harness
npm run build
npm run stage --workspace desktop
npm run pack:dir --workspace desktop
npm run test:desktop:smoke
```

The packaged smoke intentionally fails closed when the package no longer matches
source. Rebuild it with `stage` and `pack:dir`; never bypass that preflight.

## Boundaries requiring environment qualification

Deterministic integration tests cannot prove third-party availability or local
machine configuration. Release qualification must separately exercise:

- live GitHub and Azure DevOps authentication, listing, comments, approval, and
  description updates against non-production test resources;
- installed Copilot and Agency CLI launch, model selection, usage emission, and
  a real warm metasession becoming busy;
- real MCP child-server authentication and tool invocation;
- OS confirmation dialogs, file reveal, credential stores, and clipboard formats;
- signed update download, installer handoff, and rollback on every shipped OS.

These are explicit environment checks, not untested application logic. Their
request construction, state transitions, failure handling, and persistence are
covered by the automated suites above.
