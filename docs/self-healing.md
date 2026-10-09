# Self-healing & future-proofing (design plan)

> Status: **approved plan, not yet implemented.** This document captures the
> agreed design for making AI Project Studio survive future GitHub Copilot /
> Agency CLI changes without breaking. Build in the phases at the end.

## Goal

Make the IDE resilient to *future* provider changes — a new usage command, a
changed OTel/DB format, renamed columns, new CLI flags. When a format drifts the
IDE must **detect it, repair itself via a metasession, persist the repair until
the next failure, and show a Self-Healing history in Settings**. Any IDE-level
error routes into the same diagnose → repair → persist loop (safe/idempotent
actions only).

### Locked decisions
- **Heal autonomy:** automatic, but surface a non-blocking notice + history entry
  (`auto_with_notice`).
- **Hot-apply:** a validated heal takes effect immediately, no restart.
- **Discovery metasession:** allowed (counts as IDE AI credits).
- **IDE-error healing scope:** safe/idempotent allowlist only.
- **Circuit breaker K = 3** consecutive failed heals → quarantine.
- **Probe cadence:** on relevant events (session end, app start) + slow idle
  backstop; lazy-escalate on an empty-where-rows-exist read.

## What already exists (build on, don't duplicate)

| Primitive | Location | Reused for |
| --- | --- | --- |
| Healer catalog (verify→heal→re-verify, streaming) | `backend/src/self-heal/` | UI live-status pattern, SSE route shape (`main.ts:4334`) |
| Session recovery ladder (analyze via metasession, restart) | `backend/src/self-recovery/` | coordinator shape, error matcher style |
| Metasessions (headless AI turns, recorded + credited) | `backend/src/meta/`, `docs/metasessions.md` | discovery + remediation driver |
| Health probes + report | `backend/src/health/` | capability-probe service shape, metrics surface |
| **Persisted config overrides (SQLite)** | `backend/src/config/config-override-*`, `persistence/config-override-repo.ts` | durable descriptor storage ("permanent till next failure") |
| Typed event bus | `backend/src/kernel/event-bus.ts` | `adaptation.*` events, hot-apply |
| Cancellable background runner | `backend/src/kernel/background-work-runner.ts` | run heals off the HTTP path (AGENTS.md rule 8) |
| MCP config-path self-discovery via metasession | `main.ts:2386-2440`, `provider-contract.ts` (`McpSupport`) | the healing template to copy |

## Core idea: descriptor-driven parsing, heal the descriptor

The format-fragile surfaces are hardcoded today and fail silently. Replace the
literals with a small declarative **descriptor** (column/field map, command
template). Defaults = today's literals (zero behavior change when healthy).
Self-healing = regenerate a descriptor, **validate it against live data**, and
persist it as a config override.

### Three capabilities (not many)

| Capability | Backs | Today's code | Current failure mode |
| --- | --- | --- | --- |
| `cli-store` | usage **and** history (same `session-store.db`) | `cli-usage-store`, `cli-session-store`, `copilot-history-db.ts` | silent `[]` on schema drift → **data loss, no alarm** |
| `cli-otel` | fallback OTel JSONL path | `usage/cli-usage-tailer.ts` read path | parses to nothing |
| `provider-cmd` | launch command, flags, model list | `provider/copilot-adapter/` | wrong flags → launch/usage break |

`cli-store` is the dominant target: usage *and* history read the **same DB**, so
**one descriptor heals both**. Descriptors key on `providerId` (Copilot/Agency
independent).

### Descriptor (validated value object)

```
CliStoreDescriptor {
  version; providerId; schemaHash;      // schemaHash = live schema it validated against
  tables:  { usage; turns; checkpoints; sessions };
  columns: { sessionId; turnIndex; totalNanoAiu; model; createdAt;
             userMessage; assistantResponse; ... };
}
```

Queries are built from **fixed parameterized templates** using the column map —
never model-emitted SQL. Stored as a `config-override` patch (SQLite-persisted).

### Hot-apply mechanism

Config overrides are restart-gated, so descriptors flow through a live
`DescriptorRegistry` (injected into the fragile adapters), not startup config.
Heal path: persist override → `bus.emit('adaptation.descriptor.updated')` →
registry reloads → adapters pick it up on their next query (they already re-open
the DB read-only per call). No restart, no reconnect.

## Drift detection (won't cry wolf)

Pure `capability-probe-service.ts` (bounded, never-throws; mirrors
`health-report-service.ts`). Rules:

1. **Structural check first:** every descriptor-referenced table/column must
   exist (`PRAGMA table_info`, `sqlite_master`). A missing/renamed column is
   deterministic drift — catches the most likely future break.
2. **Positive source, empty parse = drift:** store has rows + tables exist, but
   descriptor-mapped query returns 0 → drift, not idle.
3. **Two-strike + debounce:** must reproduce across N consecutive probes before
   acting. Kills transient WAL-lock races.
4. **Never heal a legitimately empty store:** fresh install (structural pass,
   0 rows) = healthy.

## Heal loop (bounded, validated, reversible)

`adaptation-coordinator.ts` — pure orchestrator (shape of
`self-recovery-coordinator.ts`):

```
drift confirmed
  → DISCOVER   (metasession, noTools): ask the CLI where its store is + schema +
               how it now reports usage. The IDE also reads live schema itself.
  → SYNTHESIZE candidate descriptor: map LIVE schema → slots; model answer is a
               hint, live PRAGMA is the authority.
  → VALIDATE   against sampled live rows: must parse to plausible, non-zero,
               type-correct values. CODE decides, not the model.
  → PERSIST    override + emit descriptor.updated (hot-apply).
  → VERIFY     re-run probe; stable success → done, else rollback to previous.
```

**Trust boundary:** the metasession only *informs*; a candidate is adopted only
if it passes code validation against live data. A hallucinated/injected column
simply fails validation and is discarded — it can never corrupt reads.

CLI output is **untrusted input** (prompt-injection containment: delimited,
`noTools` discovery, never execute model-emitted SQL/commands).

## Loop prevention (nine guards — the IDE must never thrash)

Per-capability state machine:
`HEALTHY → SUSPECTED → HEALING → VERIFYING → (HEALTHY | COOLDOWN) → QUARANTINED`.

1. **Two-strike + debounce** before any heal.
2. **Single-flight per capability** + global concurrency cap (serial heals);
   probe skips while healing.
3. **No-op gate:** candidate == current descriptor → abort.
4. **Stable-success exit:** reverify must pass N consecutive probes before
   HEALED / breaker reset; otherwise rollback.
5. **Flap detection:** oscillating descriptor hashes (A→B→A) → QUARANTINED, keep
   last-known-good.
6. **Circuit breaker + backoff:** K=3 failures → QUARANTINED (manual only).
7. **Reentrancy firewall:** all self-heal operations are tagged
   (`purpose:'self-heal'`); the `adaptation.error.caught` hook **ignores
   tagged-origin errors** — a failing discovery metasession or heal action can
   never re-enter the loop. Structurally breaks "healing the healer."
8. **Error-heal recursion depth 0 + signature dedup.**
9. **Global kill switch:** one flag disables auto-healing; probes still report,
   last-known-good stays in force.

**Invariant:** always fall back to a persisted, validated, last-known-good
descriptor; auto-healing only makes bounded, debounced, validated, single-flight
forward attempts.

## Generic IDE-error healing (safe/idempotent only)

- New `adaptation.error.caught` bus event; thin forwarders in `api/` error
  middleware and `background-work-runner` classify errors (extend
  `self-recovery/recoverable-error.ts` matcher style).
- Diagnose + remediate metasession (reuse MCP-heal template), but remediation is
  gated by an **explicit allowlist**: verify a command resolves, create a missing
  directory, re-point a discovered path, install a named missing package, reset a
  corrupt cache file. **Denylist:** delete user data, mutate unrelated config,
  destructive/long ops. Model output never runs a destructive op — code gates
  which actions execute.
- Every attempt (including diagnose-only) → `adaptation_event` row.

## Default-vs-learned precedence (upgrade reconciliation)

- Stamp each learned override with the CLI version / schema-hash it validated
  against.
- On startup, if live schema-hash ≠ stamp, **re-validate the override against
  live data**; on failure, discard it and fall back to the (possibly newer)
  shipped default, then let the probe/heal loop run.
- A shipped default wins when a learned override no longer validates — an IDE
  upgrade can "unstick" a bad learned state.

## Graceful degradation

Honor the "unknown AIC is not zero" convention (agents.md): if `cli-store` is
drifted + unhealed, usage/credits render **"unavailable"**, never a misleading
`0`. App stays usable on last-known-good; Settings flags "usage may be incomplete
while adapting." No feature hard-breaks on drift.

## Persistence · API · UI

- **Schema** (`persistence/db/schema.ts`) + **`persistence/adaptation-repo.ts`**:
  `adaptation_event(id, capability, providerId, trigger, phase, diagnosis,
  before_descriptor, after_descriptor, validated, outcome, created_at)` — one row
  per step = the Settings timeline feed. Mirror `ide-usage-repo.ts`.
- **API** (`api/routes.ts` + controller): `GET /adaptation/status`,
  `GET /adaptation/history` (paginated), `POST /adaptation/:capability/heal`
  (manual, SSE — reuse `self-heal/:target/run` at `main.ts:4334`).
- **UI** `ui/src/features/settings/self-healing-section.tsx` in the existing
  **System** tab (beside `HealthSection` in `settings-view.tsx`):
  - per-capability chips: Healthy / Watching / Healing… / Needs attention
    (reuse `HealthSection` visual language);
  - live heal phases over SSE (Detecting → Discovering → Validating → Applying →
    Verifying);
  - `auto_with_notice`: non-blocking toast on auto-heal, linking to the timeline;
  - timeline rows expand to trigger → diagnosis → **before/after descriptor
    diff** → validation sample → outcome → credit cost;
  - manual controls: "Check & heal now", "Roll back this heal", "Retry"/"Dismiss"
    for quarantined;
  - **redaction** via `config-redactor` so no secrets/paths leak;
  - accessible timeline + healthy empty state.

## Telemetry

- **Source of truth:** `adaptation_event` table (also the UI feed) — one write
  path.
- **Metrics in the health report** (`GET /system-health`): per capability probe
  pass/fail counts, consecutive-fail streak, last-heal outcome, time-since-heal,
  circuit state.
- **Credits, no new bucket:** discovery/remediation metasessions run
  `scope:'internal'` → already credited under **IDE AI** (`metasessions.md`),
  recorded in `usage.meta_operations`; timeline surfaces per-heal cost.
- **Structured logs** via `kernel/logger.ts` at each transition.
- **Live SSE** via `adaptation.*` events (consistent with `api/usage-stream.ts`).
- **Never a failure source:** all recording best-effort/never-throws; a failed
  `adaptation_event` write logs and drops, never aborts a heal or re-enters the
  loop.

## Config trio (`adaptation/config.ts`, `ADAPTATION_NAMESPACE`)

`enabled` (kill switch), `autoApply` (true), `probeIdleIntervalMs` (1800000),
`driftStrikes` (2), `circuitFailureThreshold` (**3**), `backoffMs`,
`maxHealsPerDay`, `discoveryMetasession` (true), `stableSuccessProbes` (2),
`errorHealAllowlist`. Registered in `main.ts` like every other trio.

## Testing / coverage (100% backend gate)

Pure & fully unit-testable with fake metasession + fake store, exercising every
branch: drift, false-alarm debounce, validation-reject, rollback, flap→quarantine,
circuit-breaker (K=3), no-op gate, reentrancy firewall, idempotent-allowlist deny,
upgrade reconciliation. Only thin IO (raw PRAGMA/`sqlite_master` reader, SSE
wiring) goes on the `vitest.config.ts` `exclude` list. UI keeps its `.test.tsx`
suite (only `src/lib/**` is coverage-gated).

## Phasing (each independently shippable; each ends green on `npm run build` +
backend + UI coverage gates)

1. **`cli-store` descriptor + registry + probe + heal loop + `adaptation_event`
   + Settings timeline + hot-apply.** Highest value (kills silent usage/history
   data-loss); proves the whole loop end-to-end.
2. **`cli-otel` descriptor + probe + heal.**
3. **`provider-cmd` generic `selfCheck()` capability on `IAIProvider`** (per
   `docs/adding-a-provider.md`; no `if (tool === …)`).
4. **Generic IDE-error → coordinator hook (safe/idempotent allowlist).**
