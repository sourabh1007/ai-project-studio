# Architecture

AI Project Studio is a three-tier desktop app. This document explains the layers, the main data flows, and the patterns that keep the backend testable.

## Layers

| Layer | Workspace | Responsibility |
| --- | --- | --- |
| **Electron shell** | `desktop/` | Creates the window, spawns the backend as a child process, loads the UI, bridges native theme over IPC. |
| **UI** | `ui/` | React + Vite SPA. Talks to the backend over HTTP, subscribes to SSE for live updates, and to a WebSocket for the interactive terminal. |
| **Backend** | `backend/` | Express API + domain modules. Owns all business logic, persistence, CLI orchestration, and telemetry ingestion. |

## Backend patterns

### Ports & adapters (hexagonal)
Domain logic depends on **interfaces** (ports), not concrete IO. Examples of ports: `session/session-repo-port.ts`, `usage/usage-repo-port.ts`, `summarizer/summary-store-port.ts`, `provider/provider-contract.ts`. Concrete adapters (SQLite repos, node-pty spawner, HTTP controllers) implement these ports and are kept thin so they can be excluded from the coverage gate.

### Composition root
`backend/src/main.ts` is the **only** place that constructs concrete adapters and wires them together. It:
1. Registers every module's config namespace/schema.
2. Loads + validates config from the environment (`CW` prefix).
3. Builds kernel primitives, repos, services, and providers.
4. Assembles the route table (`api/routes.ts`) and starts Express.

Everything else receives its collaborators through an explicit `*Deps` object — no service constructs its own dependencies.

### Event bus
`kernel/event-bus.ts` is a typed pub/sub used for live, cross-module updates. Producers emit events (`usage.recorded`, `session.started`, `session.ended`); `api/usage-stream.ts` forwards them to the UI over SSE. This decouples telemetry ingestion from delivery.

### Per-module config
Each module exports `{ <NAME>_NAMESPACE, <name>ConfigSchema, <name>Defaults }` from its `config.ts` (zod-validated). `main.ts` registers them all; values come from env via the config loader. There is no monolithic config object.

## Key data flows

### Live usage → cost → UI
```
CLI writes usage rows ─▶ provider/cli-store/cli-usage-store.ts (reads session-store.db)
                     ─▶ usage/cli-usage-tailer.ts (polls, dedups, emits UsageEvent)
                     ─▶ usage/usage-recorder.ts (normalize + credit/credit-calculator + persist + emit usage.recorded)
                     ─▶ aggregation/feature-analytics.ts (join usage with sessions)
                     ─▶ api/usage-stream.ts (SSE) + api/routes.ts (REST)
                     ─▶ ui/src/hooks/use-usage-stream.ts + use-workspace-stats.ts (render)
```

### Running an interactive session
```
UI opens a session ─▶ terminal/terminal-manager.ts launches the CLI TUI in a PTY (node-pty)
                   ─▶ skills instructions are seeded once the CLI prompt is ready, then submitted
                   ─▶ output streams to the UI over WebSocket (terminal WS server)
                   ─▶ on exit: transcript saved; session.ended emitted; session-summary/auto may trigger
```

### Skills seeding (subtle, don't regress)
The interactive CLI needs its input prompt to be **ready** before receiving keystrokes, and treats a fast multi-line write as a *paste*. `terminal/terminal-manager.ts` therefore waits for a ready marker in the CLI output (config: `instructionSeedReadyPattern`, with a timeout fallback) before writing the instruction block, then sends the submit keystroke as a **separate** write after `instructionSeedSubmitDelayMs`. See `backend/src/terminal/config.ts`.

## Storage

- `workspace.db` (SQLite via `node:sqlite`) — features, sessions, usage, transcripts, summaries, skills, feature tasks.
- The CLI's own `session-store.db` — read-only source of truth for usage/telemetry (never written by this app).

## Diagram

See the module-wise block diagram in the [README](../README.md#architecture-module-wise).
