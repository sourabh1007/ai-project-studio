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

## Migration recovery

Managed historical migrations use explicit column mappings/defaults and record
their stages in `schema_migrations` and `schema_migration_stages`. File-backed
migrations create quiesced SQLite backups before copying data, verify row counts
and contents, and only then retire legacy tables. Existing conflicting rows fail
visibly rather than being silently ignored.

After an interrupted migration, a missing legacy table alone does not establish
success: the replacement is verified against the recorded backup. Missing,
damaged or unreadable recovery data leaves a failed journal and an actionable
error. `restoreMigrationBackup()` requires all live database connections to be
closed. Cross-file WAL crash atomicity is not assumed; recovery relies on staged
verification and the retained backup.

## Terminal transport and recovery

Terminal WebSockets use protocol v2 with a PTY generation, ordered input
sequence, readiness state and explicit acknowledgements. A written acknowledgement
means the PTY accepted the write, not that a command completed. Startup input is
bounded and queued until ready; reconnecting never blindly replays uncertain
input. The browser and backend must be upgraded together.

Interactive retry never reconstructs commands from browser keystrokes. Only an
exact provider-confirmed replay-safe request can authorize automatic replay.
Current providers do not supply that confirmation, so errors surface manual
retry guidance. New user input, cancellation, replacement and shutdown invalidate
older recovery, including delayed analysis and submit keystrokes. Normal initial
bootstrap still precedes queued user input.

Persisted terminal transcripts use a per-session streaming ANSI filter. CSI,
OSC and other control strings can span PTY chunks without leaking fragments
into summaries; unterminated control strings do not accumulate parser buffers.
Live output remains raw rather than being rewritten by the transcript filter.

Scrollback and transcript limits count UTF-8 bytes, not JavaScript string length.
Retention uses blocks of at most 4,096 UTF-16 code units and head offsets rather than
rescanning or copying a full window for each character. A split surrogate pair
is completed before retention; malformed standalone units become U+FFFD, with
at most one pending high surrogate held outside the retained-byte budget.

Truncated replay starts at a parser-confirmed text boundary; it is not a full
terminal-screen reconstruction. A client joining inside a discarded control
string waits until that control ends, without buffering its payload. Joining
between the two ST characters or the halves of a surrogate pair preserves the
required pending context. Clients already receiving live output retain the
original frames; late joiners may receive a boundary-trimmed first frame.

The browser requests `/stream?output=0` for workspace events and does not retain
a second, unused stdout/stderr history in React state. Terminal output continues
through the dedicated WebSocket; lifecycle, file, notice and usage events still
arrive over SSE. Omitting `output=0` preserves the existing SSE output behavior
for other API consumers. This removes redundant output retention, not the need
for separate slow-consumer and usage-history budgets.

## Warm execution failure policy

Cold fallback after a warm attempt requires explicit evidence that the prompt
was not dispatched. Unknown failures and post-dispatch timeouts do not authorize
another execution. Uncertain clients are quarantined and disposed rather than
leased again; process counts retain stopping clients until their exit.

## Composition root
`main.ts` — registers config schemas, builds deps, wires providers/services/repos/routes, and starts the server. Adding a module means wiring it here.

## Automation run identity and uncertain retries

Scheduled checks and Run now share scheduler admission. Run history distinguishes
`queued`, `checking`, `acting`, `finished`, `cancelled`, `interrupted` and
`uncertain` phases, separately from the final `ok`/`failed`/`skipped` outcome.
Records include their scheduled/manual source, durable deduplication identity,
scheduled time, dispatch time and check-provided occurrence key. A process exit
or cancellation is not proof that a dispatched external action had no effect.

An automation's `uncertainty` exposes a warning `summary` and
`unresolvedRunIds`. All unresolved occurrences matter, not just the newest one;
an unresolved occurrence without a known identity blocks automatic replay.
Ordinary polling or resume must not substitute for deliberate retry authorization.

`POST <api.basePath>/automations/:id/run` accepts an optional body:

```json
{
  "uncertaintyAcknowledgement": {
    "snapshotRunIds": ["unresolved-run-id"],
    "targetRunIds": ["unresolved-run-id"]
  }
}
```

`snapshotRunIds` describes the full unresolved snapshot presented to the user;
`targetRunIds` identifies the attempts they deliberately authorize retrying.
Clients must present the risk that effects may already have occurred, rather
than manufacture acknowledgment from an ordinary Run now click. Stale
acknowledgments are not permission to retry newly discovered uncertainty.
Retry records preserve the acknowledged targets and snapshot; authorization is
not evidence that an old uncertain outcome succeeded.

Ordinary busy Run now requests can coalesce with existing work. An acknowledged
retry that conflicts with an owned scheduled run or another owned retry returns
`409 Conflict`, rather than claiming acceptance and discarding the authorization.
An unowned queued manual retry can reuse its durable identity only with the same
persisted acknowledgment. The UI retains rejected confirmation errors and
refreshes visible run history on updates and reopening.

## Saved AI operations

`meta/recording-meta-runner.ts` assigns an application-owned operation ID before
dispatch and persists lifecycle state and full results in `usage.meta_operations`.
Restart recovery marks unfinished operations interrupted without re-executing
them. Unknown or unsupported usage is not treated as zero cost.

Physical ownership aggregates every warm/cold attempt independently. A cold
deadline expiry or routing cancellation before dispatch records a settled
`not-started` attempt rather than leaving a phantom native hold. That proof does
not release an earlier warm attempt: quarantined native work still requires its
own exit confirmation. Scoped quiescence includes result persistence and
ownership-bookkeeping completion.

`GET <api.basePath>/meta/operations` returns paginated metadata, with optional
`featureId`, `sessionId`, `automationId`, `after`, and `limit` parameters.
`GET <api.basePath>/meta/operations/:operationId` retrieves the full stored result.
The `metaOperations` namespace defaults to pages of 25, a maximum page size of
100, and recovery pages of 100. Settings > Metasession mounts the saved-operation
viewer under the normal API provider. Session-filtered pages use the normalized
`usage.meta_operation_sessions` index and keyset pagination rather than scanning
JSON histories. Initial creation atomically backfills application/origin session
IDs, never provider-session IDs. Operation writes update the index in the same
transaction; scoped deletion cascades to its index rows within usage storage.

## Shared headless process admission

The `processAdmission` namespace defaults to 8 total process reservations, at
most 4 warm ACP hosts, and 32 queued acquisitions shared between warm waiters
and cold launches. One admission instance is injected into every warm pool
(including pools added live) and the headless session launcher. At least one
slot is reserved from warm prefill for cold work; queued cold launches take
priority when native capacity becomes free. These are host/startup limits:
interactive PTYs and provider-created descendant processes are not included.

Reservations survive startup, quarantine, and unconfirmed termination until
actual native exit or proven failure before spawn. Queue cancellation releases
its queue slot without releasing any still-live process. Global shutdown closes
admission before cancelling producers, preventing replenishment during drains.
Pool closure attempts every client even when an individual disposal fails.
Quarantined live clients remain eligible for later termination retries; a
successful kill request alone never releases their reservations.
Live resizing also continues its retirement sweep after a failed termination
and retries quarantined clients on a subsequent resize, without interrupting
busy turns that were deliberately allowed to drain.
Removing a pool sets its target to zero immediately to prevent replenishment,
retains its draining status until native exits, and reports/retries retirement
errors rather than abandoning cleanup or throwing from a timer. Settings keeps
saved targets after failed live changes and offers an explicit Save retry
instead of claiming that every live operation succeeded.
Saved limit changes are restart-gated like other general configuration; the
internal `reconfigure` port supports safe retirement without treating a lowered
limit as proof that a process exited.

`GET <api.basePath>/meta/pools` includes current headless counts and limits.
Settings shows capacity-limited warm targets explicitly, including the actual
ready/warming counts, rather than reverting a saved target or implying that
blocked warm-up has completed.

## Bounded live streams

The `sse` configuration namespace limits all three SSE endpoints (workspace,
installation and self-heal) together. Defaults are 32 connections, 1 MiB per
frame, 2 MiB buffered per connection, 16 MiB in total, and a 30-second blocked
write timeout. Queued frames retain order and resume on native `drain`; final
events flush before a normal end. Overflow or a stalled connection is logged
and disconnected rather than silently dropping individual events. Native
write buffers count toward the budgets, and closing a connection removes its
subscriptions and timers. Admission returns HTTP 503 when the connection limit
is reached. Saved overrides apply when the backend starts.

The renderer bounds each derived live cache to 256 entries and 256 Ki serialized
UTF-16 code units, including keys. Payloads over 1 Mi code units are rejected
before JSON parsing. It explains interruptions/evictions in the connection
banner; reconnecting is not presented as replaying missed events. Persisted
usage remains authoritative. Incomplete live-only usage shows **Usage pending**
instead of a lower or zero total, and correction/reconnect signals refresh saved
statistics even when cache entry counts do not change. High-frequency activity
lines do not trigger statistics requests.

## Clipboard attachment limits (desktop)

Native image paste uses `desktop/owned-attachments.cjs` and stores uniquely
named, session-labelled files under the application profile, not the shared
temporary directory. Limits are 8 MiB per file, 64 MiB total, and 64 files,
including files retained after restart. Images exceeding 16,777,216 pixels or
8192 pixels on either axis are rejected before PNG encoding; Electron's initial
native clipboard acquisition itself cannot be pre-bounded by this API.

Copied Explorer paths stay external and structured until terminal encoding;
they are never adopted or deleted. Quota, storage, and image errors are visible
and do not trigger fallback text paste or automatic replay.

Automatic attachment cleanup is **not available**: a paste acknowledgement or
an app-session deletion does not prove that resumable provider history no longer
references a file. Retained images continue counting toward quota. The internal
`releaseConfirmedUnused` port requires authoritative permanent-unreference proof
and a current issued lease; durable post-restart lease recovery is not wired.
Legacy global-temporary-directory images are not adopted or removed.

Settings > Diagnostics > Retained clipboard images provides manual quota recovery.
Manual removal is a separate, destructive user action, not a claim that images
are no longer referenced. The native bridge lists bounded image-file metadata
and issues opaque, per-listing selection IDs instead of accepting renderer
paths. Removal requires both a native confirmation and acknowledgement that
active, previous, or resumed prompts may break. Sender trust and selected-file
identity are rechecked after confirmation; changed, linked, or stale selections
are rejected. Partial failures report how many files were actually removed.
Manual removal works after restart and frees the corresponding storage quota.

## Ongoing usage recovery

Ended sessions remain eligible for usage capture when provider data is late or
temporarily unavailable. `lifecycle/stopped-capture-recovery.ts` visits unfinished
captures through bounded keyset pages, using one application-level timer rather
than a polling timer per historical session. The `lifecycle` namespace defaults
to eight captures per tick (`stoppedCaptureRecoveryPageSize`) every 1,500 ms
(`stoppedCaptureRecoveryIntervalMs`). Ephemeral tailers perform bounded,
resumable finalization and are stopped after each visit. Their per-capture
work remains subject to the usage capture page/final-drain budgets. Missing/live
sessions are skipped; failed entries do not prevent later entries from being
considered.

The coordinator preserves fair page progress when stopped mid-pass and rejects
callbacks from older start/stop generations. It rechecks session ownership after
tailer construction. Page reads, per-entry recovery and cleanup failures are
reported separately. During coordinated shutdown, `stop()` invalidates periodic
work; an explicit `finalize()` can perform one bounded pass before database
closure. Source EOF alone does not establish authoritative usage finality.

## Bounded file logging

The `logging` namespace controls the file sink. Defaults are 10 MiB per file
(`maxFileBytes`), 14 retained files including the active file
(`retainedFileCount`), and 64 KiB per record including its newline
(`maxRecordBytes`). File capacity must be at least record capacity. Settings
changes take effect on backend restart; saved overrides apply after opening the
workspace database, with environment values taking precedence. Bootstrap
diagnostics use the console until that effective retention policy is available,
so startup does not prune files using defaults that differ from saved settings.

Files roll over by day and size. Retention applies only to regular files with
the configured prefix and recognized daily/sequence naming, preserving unrelated
files and symlinks. Space is reclaimed before admitting another managed file;
with a one-file policy, a full owned file is replaced rather than allowing
archives to grow. Failed pruning prevents additional managed files instead of
silently disabling the budget. Normal appends recheck the target and its size
without rescanning the entire directory.

Formatting bounds bytes, depth, node count and collection traversal. Oversized,
circular or unsupported values are explicitly truncated or omitted; ordinary
accessors and custom serializers are not used to expose otherwise hidden
properties. File/retention/formatting failures produce bounded metadata
notifications, with repeated failures deduplicated and recovery tracked by
operation, rather than recursive logging or unbounded archive growth.

These limits assume one application writer owns the configured log directory
and prefix. Target checks reject symlinks and nonregular files, but are not an
adversarial filesystem race defense or a transaction across multiple writers.
