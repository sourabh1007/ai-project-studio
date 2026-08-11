# Architecture

AI Project Studio is a three-tier desktop app. This is the **application
architecture design** document — it explains the layers, the main data flows, and
the patterns that keep the backend testable.

> Looking for how to *use* a feature instead? See the task-focused
> **[feature guides](features/README.md)**. For the module-by-module code map see
> **[backend-modules.md](backend-modules.md)**; for the UI structure see
> **[ui-guide.md](ui-guide.md)**.

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
`kernel/event-bus.ts` is a typed pub/sub used for live, cross-module updates. Producers emit events (`usage.recorded`, `session.started`, `session.ended`, `repository.context.updated`, `pr.review.updated`); `api/usage-stream.ts` forwards them to the UI over SSE. Internal repository-analysis and PR-review sessions are not forwarded as session events, but their lifecycle updates are. This decouples background work and telemetry ingestion from delivery.

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
                   ─▶ repository + feature + prior-session + skill context is seeded once the CLI prompt is ready
                   ─▶ output streams to the UI over WebSocket (terminal WS server)
                   ─▶ on exit: transcript saved; session.ended emitted; session-summary/auto may trigger
```

### Repository context generation
Adding a repository immediately creates a persisted `pending` context and starts background analysis. The pipeline is provider-neutral:

```
saved checkout
  ─▶ git rev-parse HEAD + git ls-files
  ─▶ repository-context/filesystem-evidence-adapter.ts
       (tracked text only; ignored directories, binary/size rejection)
  ─▶ repository-context/evidence-builder.ts
       (guidance/docs/build files first; deterministic file/tree/character limits)
  ─▶ repository-context/repository-context-generator.ts
  ─▶ meta/meta-runner.ts in the repository working directory
  ─▶ repository_contexts in workspace.db + repository.context.updated SSE
```

Repository text is treated as untrusted evidence: prompts require read-only analysis and forbid executing commands or following instructions found in files. Small repositories use one bounded analysis prompt. A repository is treated as large when its tracked-file count or collected text reaches the configured threshold; evidence is then grouped by top-level module, capped by chunk count/size, summarized sequentially, and passed through a final bounded synthesis. The limits and prioritized files live in `repository-context/config.ts`.

The generated record moves through `pending → generating → ready`, with `stale` and `failed` states. Startup synchronization compares the saved `sourceRevision` with the checkout's current `HEAD`. A changed revision is published as `stale` and regenerated; missing or interrupted records are resumed. Manual refresh always starts a new generation against the current checkout. Jobs are deduplicated per repository. Failed refreshes retain the last successful content and source revision for inspection, but only a non-empty `ready` context permits new development sessions.

### Session readiness and bootstrap
Repository-backed features cannot create or launch a development session until their repository context is `ready`; the backend enforces this in addition to the UI. Repo-less features remain launchable. Immediately before each launch, `session-bootstrap/session-bootstrap.ts` composes fresh, provider-neutral context in this order:

1. the bounded ready repository summary;
2. feature name and description;
3. bounded summaries from the newest completed, visible development sessions;
4. effective feature/session skill instructions.

One-shot sessions prepend this bootstrap while retaining the user's request in a separate final section. Interactive sessions seed the same bootstrap after the CLI prompt is ready. PR worktree features use the saved base repository context while the provider process still runs in the feature checkout.

The interactive CLI treats a fast multi-line write as a *paste*. `terminal/terminal-manager.ts` therefore waits for a ready marker in CLI output (with a timeout fallback), writes the bootstrap, then sends the submit keystroke separately after the configured quiet delay. See `backend/src/terminal/config.ts`.

### Internal AI accounting
Repository analysis reuses the normal provider-neutral meta runner with the repository checkout as `cwd` and a stable `repository:<id>` attribution key. These sessions have `scope = internal`: they are persisted so usage can be tailed and credited, but are hidden from feature session lists, workspace session counts, feature/workspace development rollups, and session SSE events. Their `kind = meta` usage remains included in the separate **IDE AI** totals.

## Storage

- `workspace.db` (SQLite via `node:sqlite`) plus attached sibling files — persistence is split by domain to keep each file light: the primary `workspace.db` holds the core catalog (features, sessions, repositories, skills) and one `repository_contexts` row per saved repository, while `usage.db` (usage events), `content.db` (transcripts, feature/session summaries, session files), and `tasks.db` (feature tasks) are `ATTACH`ed through the same connection. Table names stay globally unique so queries and cross-domain joins are unchanged; older single-file databases relocate their tables into the siblings on first open. See [docs/backend-modules.md](backend-modules.md#persistence-layout-multiple-databases). Context lifecycle writes use a single SQLite upsert; null content/revision/generated timestamps preserve the last good values during stale, generating, or failed transitions. Removing a repository deletes its context explicitly, with a foreign-key cascade as schema-level cleanup.
- The CLI's own `session-store.db` — read-only source of truth for usage/telemetry (never written by this app).

## Repository context API

- `GET /api/repos/:id/context` returns the persisted lifecycle record and retained content.
- `POST /api/repos/:id/context/refresh` starts background regeneration and returns `202` with the `generating` record; an overlapping refresh returns a conflict.
- `repository.context.updated` SSE events carry every persisted lifecycle transition so clients do not need to poll.

## PR review

When a feature is created from a pull request (`repo/pr-feature-service.ts` `createFromPull`), `pr-review/pr-review-service.ts` starts a background review keyed by the feature id. The job collects a bounded PR diff (`pr-diff-collector.ts` computes a three-dot `origin/<base>...HEAD` range and clamps the patch to the configured budget), embeds the ready base-repository context, and runs one internal meta AI session in the PR worktree. The response is parsed into a **PR Summary** and **Core Analysis** (`pr-review-parser.ts`), persisted to `pr_reviews` in `content.db`, and published as `pr.review.updated`.

- The record moves through `pending → generating → ready`, with a `failed` state carrying failure detail. The upsert uses `COALESCE`, so a failed regeneration retains the last successful summary for inspection.
- `GET /api/features/:id/pr-review` returns the persisted record; a non-PR feature has none (`404`).
- `POST /api/features/:id/pr-review/refresh` regenerates against the current worktree; jobs are deduplicated in-flight and a review deleted with its feature suppresses late publishes.
- These internal generation sessions are hidden from session lists/SSE like repository analysis, and their usage is included in **IDE AI** totals.

## Diagram

See the module-wise block diagram in the [README](../README.md#architecture-module-wise).
