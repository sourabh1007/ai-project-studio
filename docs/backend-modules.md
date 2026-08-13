# Backend module reference

Every directory under `backend/src`. Each module owns its own `config.ts` (namespace + zod schema + defaults) where applicable, and exposes ports/contracts for testability.

## Work organization
| Module | Responsibility | Key files |
| --- | --- | --- |
| `feature/` | Core feature aggregate/service and feature-scoped work-summary contract. | `feature-service.ts`, `feature-contract.ts`, `feature-work-summary.ts` |
| `session/` | Session lifecycle: contracts, state machine, factory, launcher, reconciliation, transcript capture. | `session-launcher.ts`, `session-factory.ts`, `session-state-machine.ts`, `session-repo-port.ts` |
| `session-bootstrap/` | Gates repository-backed development sessions on ready context and composes launch-only repository, feature, prior-session-summary, and skill instructions. | `session-bootstrap.ts` |
| `feature-tasks/` | Generate, parse, and run AI task plans attached to a feature; track progress. | `feature-tasks-service.ts`, `task-plan-runner.ts`, `task-plan-parser.ts` |
| `pr-review/` | Generates and tracks the automated review of a pull-request review feature: collects a bounded PR diff, embeds the ready repository context, runs an internal meta AI session, parses the summary + core analysis, persists lifecycle state, and publishes `pr.review.updated`. | `pr-review-service.ts`, `pr-diff-collector.ts`, `pr-review-prompt.ts`, `pr-review-parser.ts`, `config.ts` |
| `automation/` | Owns workspace-global monitors and tracked subagents: CRUD/lifecycle, interval scheduling and resume, pure condition evaluation, shell/HTTP/AI/CI checks, metasession/subagent/report/command actions, REST + MCP bridge progress, and live automation events. | `automation-contract.ts`, `automation-service.ts`, `automation-scheduler.ts`, `check-runner.ts`, `action-runner.ts`, `subagent-service.ts`, `condition.ts`, `config.ts`, `persistence/automation-repo.ts`, `persistence/subagent-repo.ts` |
| `skills/` | Skill tagging + prompt composition (instruction blocks seeded into sessions). | `skills-service.ts`, `skill-prompt-composer.ts`, `skills-repo-port.ts` |

## Execution
| Module | Responsibility | Key files |
| --- | --- | --- |
| `provider/` | Provider abstraction + registry/resolver + concrete CLI adapters + CLI stores/process kernel. | `provider-contract.ts`, `provider-registry.ts`, `provider-resolver.ts`, `copilot-adapter/`, `agency-adapter/`, `cli-store/` |
| `terminal/` | PTY + WebSocket adapter for live interactive sessions; enforces bootstrap readiness and seeds repository/feature/memory/skill instructions after the prompt is ready. | `terminal-manager.ts`, `terminal-session.ts`, `node-pty-spawner.ts`, `executable-resolver.ts` |
| `meta/` | Runs/parses provider-neutral headless AI sessions used for summaries, plans, and repository analysis; accepts a working directory and hidden internal scope. | `meta-runner.ts`, `meta-response-extractor.ts` |
| `mcp/` | Manages Model Context Protocol servers per provider: reads/writes server specs, restarts servers, probes for available tools, and toggles individual tools; changes apply to open sessions. | `mcp-service.ts`, `mcp-contract.ts`, `mcp-tool-inspector-adapter.ts` |

## Telemetry & cost
| Module | Responsibility | Key files |
| --- | --- | --- |
| `usage/` | Ingests CLI/OTel usage: tail, dedup, normalize, and record to persistence; emits `usage.recorded`. | `usage-recorder.ts`, `cli-usage-tailer.ts`, `usage-normalizer.ts`, `usage-repo-port.ts` |
| `credit/` | Converts usage events to credits (AIC) via pluggable strategies. | `credit-calculator.ts`, `credit-strategies.ts` |
| `aggregation/` | Read-side rollup joining usage with session membership/timing into feature/workspace analytics. | `feature-analytics.ts`, `aggregation-contract.ts` |
| `ide-usage/` | Computes "IDE AI" overhead usage (including hidden repository-analysis meta sessions) separately from visible development work. | `ide-usage-service.ts` |

## Knowledge
| Module | Responsibility | Key files |
| --- | --- | --- |
| `summarizer/` | Feature/session transcript collection and summary prompt/response pipeline. | `summary-runner.ts`, `transcript-collector.ts`, `summary-store-port.ts` |
| `session-summary/` | Per-session summary generation and automatic triggering on session end. | `session-summary-runner.ts`, `session-summary-auto.ts` |
| `repository-context/` | Generates and coordinates repository understanding. Reads `HEAD` and tracked files through Git, collects bounded text evidence, prioritizes guidance/docs/build files, uses single-pass or top-level chunk+synthesis analysis for large repositories, persists lifecycle state, refreshes changed checkouts, and publishes updates. | `repository-context-coordinator.ts`, `repository-evidence-service.ts`, `evidence-builder.ts`, `repository-context-generator.ts`, `repository-analysis-executor.ts`, `config.ts` |
| `session-import/` | Imports provider-native past sessions into workspace sessions. | `session-import-service.ts` |
| `copilot-history/` | Reads the provider's historical session database for import/analysis. | `copilot-history-reader.ts`, `copilot-history-db.ts` |

## Platform
| Module | Responsibility | Key files |
| --- | --- | --- |
| `kernel/` | Shared primitives: event bus, clock, ids, logger, typed error classes. | `event-bus.ts`, `clock.ts`, `logger.ts`, `error-types.ts` |
| `config/` | Config infrastructure: schema registry, env loader, validation, secret resolution. | `config-schema-registry.ts`, `config-loader.ts`, `config-validator.ts` |
| `persistence/` | SQLite connection, schema, and repos for every persisted aggregate. Storage is split across several sibling database files (see below) attached through one connection. `repository-context-repo.ts` atomically upserts lifecycle state, retains last-good content during later attempts, and deletes context with its repository. Internal-session scope is persisted for visibility filtering while meta usage remains available to IDE AI reports. | `db/connection.ts`, `db/schema.ts`, `repository-context-repo.ts`, `*-repo.ts` |
| `workspace/` | Workspace admin/path utilities and migration helpers. | `workspace-admin-service.ts`, `workspace-paths.ts` |
| `api/` | HTTP/SSE boundary: Express adapter, route table, controllers, validation, stream forwarding. Repository routes initialize context after add, expose `GET /repos/:id/context` and `POST /repos/:id/context/refresh`, clean it up on removal, and stream `repository.context.updated`. PR review routes expose `GET /features/:id/pr-review` and `POST /features/:id/pr-review/refresh` and stream `pr.review.updated`. Automation routes expose `/automations` CRUD/lifecycle operations and stream `automation.updated`, `automation.removed`, and `subagent.updated`. Terminal creation rejects repository-backed dev sessions until context is ready. | `routes.ts`, `repo-controller.ts`, `pr-review-controller.ts`, `automation-controller.ts`, `terminal-controller.ts`, `usage-stream.ts` |

## Persistence layout (multiple databases)

Rather than one monolithic file, the workspace is partitioned into several SQLite database files so append-heavy data stays out of the small core catalog and each file remains light and independently manageable. `db/connection.ts` opens the primary file and `ATTACH`es the siblings (in-memory databases when the primary is `:memory:`); `db/schema.ts` declares the grouping in `DATABASE_GROUPS` and owns the layout.

| File | Schema alias | Tables |
| --- | --- | --- |
| `workspace.db` (primary) | `main` | `features`, `sessions`, `repositories`, `repository_contexts`, `skills`, `skill_attachments` |
| `usage.db` | `usage` | `usage_events` |
| `content.db` | `content` | `transcripts`, `summaries`, `session_summaries`, `session_files`, `pr_reviews` |
| `tasks.db` | `tasks` | `feature_tasks` |
| `automations.db` | `automations` | `automations`, `automation_runs`, `subagents` |

- Table names are globally unique, so repos keep issuing unqualified SQL and cross-group reads (e.g. `aggregate-repo`'s `usage_events ⋈ sessions` visibility filter) work through the single attached connection.
- The FK-linked pair `repositories` → `repository_contexts` (ON DELETE CASCADE) stays in the same file because SQLite cannot enforce foreign keys across attached databases.
- Opening an older single-file `workspace.db` transparently relocates the partitioned tables into their sibling files on first run (`applySchema` moves each table out of `main`, then drops the primary copy).

## Repository context lifecycle

- `pending`, `generating`, `ready`, `stale`, and `failed` are persisted in `repository_contexts` with source revision, transition timestamps, and retryable failure details.
- `repository-context-coordinator.ts` deduplicates background jobs. On startup it creates missing records, resumes interrupted states, and compares saved revisions with current Git `HEAD`; changed checkouts become stale and regenerate.
- Generation and revision failures retain the last successful content. This keeps the viewer useful, but `session-bootstrap/` accepts only non-empty `ready` content.
- Generation runs as an ordered, tracked pipeline (`repository-context-steps.ts`): `collect-evidence` → `analyze` → `persist`. Each step's status (`pending`/`running`/`ok`/`failed`/`skipped`) and detail are persisted in `repository_contexts.steps` and streamed live; on failure the failing step key is stored in `failure_step` and remaining steps are skipped, so the UI shows exactly where collection stopped.
- Evidence collection is tracked-file-only and bounded by file bytes, per-file characters, total characters, tree length, and file count. Binary, oversized, ignored-directory, absolute, and traversal paths are rejected.
- Large repositories are grouped by top-level path, bounded by `maxChunks`/`maxChunkChars`, summarized per module, then synthesized. All prompts explicitly treat repository contents as untrusted, read-only evidence.
- Repository analysis runs as an internal meta session in the checkout directory. It is hidden from visible session lists/events and development rollups, while its usage is credited under IDE AI.

## Session bootstrap

`session-bootstrap/session-bootstrap.ts` is evaluated immediately before launch so memory and skills are current. It includes the ready repository summary, feature details, newest completed development-session summaries (bounded by item and character limits), and effective skills. One-shot launchers prepend it to the user request; interactive terminals seed it after prompt readiness. Meta/internal sessions are excluded, and PR worktrees reuse their base repository's context.

## Composition root
`main.ts` — registers config schemas, builds deps, wires providers/services/repos/routes, and starts the server. Adding a module means wiring it here.
