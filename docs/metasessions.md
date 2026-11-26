# Metasessions

A **metasession** is a *headless* AI turn: the app drives the same CLI a user
would chat with, but non-interactively, captures the answer, and credits its
usage. Everything AI-native in the app — summaries, task plans, repository
analysis, PR reviews, monitors, and the New Task agent — runs on metasessions.

> Not the interactive terminal (that is a live `node-pty` session the user
> types into). A metasession has no terminal; it runs a prompt and returns text.

Interactive availability does not guarantee automated execution. Agency uses
native configuration and authentication; optional zero-MCP isolation refuses
unverifiable Agency overlays. Copilot and Claude preflight can also refuse
unsafe/uninspectable configuration.
These failures do not authorize a silent provider switch or weaker safety flags.
See [headless tool isolation](adding-a-provider.md#headless-tool-isolation).

## The MetaRunner port

Every AI feature depends on one small port, never the launcher:

```ts
interface MetaRunner {
  run(req: MetaRequest): Promise<string>;           // just the text
  runDetailed(req: MetaRequest): Promise<MetaRunResult>; // text + sessionId + usage
}
```

A `MetaRequest` carries the prompt, an optional working directory (`cwd`), a
`scope`, and a `label` used for usage attribution. `meta/meta-runner.ts` is the
cold implementation: it launches a provider-neutral CLI session, streams its
events, extracts the final answer (`meta-response-extractor.ts`), and stops the
process the moment the turn is done.

## Runner chain (composed in `main.ts`)

The single `metaAi` handed to every feature is a stack of decorators:

```
feature ─▶ owned ─▶ recording ─▶ pooled ─▶ warm pool (ACP hosts)
                                        └▶ cold runner (fresh CLI launch)
```

| Layer | File | Responsibility |
| --- | --- | --- |
| **owned** | `meta/owned-meta-runner.ts` | Assigns an app-owned operation id; ties the run to restart-safe ownership bookkeeping. |
| **recording** | `meta/recording-meta-runner.ts` | Persists lifecycle + full result to `usage.meta_operations` (the *Saved AI operations* history). |
| **pooled** | `meta/pooled-meta-runner.ts` | Routes to a warm host when one fits; otherwise falls back to a cold launch. |
| **warm pool** | `meta/acp/` | Pre-warmed **ACP** (Agent Client Protocol) hosts leased per turn for near-instant starts. |
| **cold** | `meta/meta-runner.ts` | Spawns a fresh headless CLI session on demand. |

The warm pool is prefilled to its saved target, not created on demand;
`GET /meta/pools` and
**Settings ▸ Metasession** expose live ready/warming counts and supported pool
target changes. Saved general capacity/admission limits remain restart-gated;
a successful save alone does not prove a running process was retired.

Copilot and Agency supply provider-owned ACP commands. The default/legacy
`copilot` warm executable setting follows the selected supported CLI; an
explicit custom path must match its configured provider. Agency runs
`agency copilot -- --acp` with native MCP and authentication policies, never a
silently substituted Copilot provider. Keep Agency's headless policy `native`;
isolated overlays still fail closed. Prewarming can initialize native MCP
servers or require user sign-in; Studio never answers authentication for you.

Workers initialize both ACP and a native session before becoming idle.
`meta.warmPool.size = 10` maintains ten initialized workers, with unhealthy
workers retired and replaced. Shared process admission can block filling a
target; Settings reports that condition without rewriting the target or
pretending fewer workers are ready. Idle/busy/warming states are measured.

The shared pool's workers are tool-free so strict Review Board turns use warm
capacity without weakening no-tools rules. Tool-required agents keep their
native cold path. Fresh native sessions isolate review turns and working
directories; concrete review models are applied over ACP before dispatch.
Warm-enabled Review Board runs use all ready workers, including manifest-backed
runs previously capped at two perspectives. Ten ready workers permit ten
parallel perspectives; other requests share the bounded fair lease queue.
Reviews requested during startup queue at the saved capacity and wait for
initialization, rather than locking the entire review to the first ready worker.
Strict warm reviews wait for startup/leases and retry on warm workers, not
one-shot launches. The default budget is five attempts per step, including
rejected responses, with the overall review deadline preserved. Completed
perspectives remain saved. Exhausted retries or required sign-in are explicit
failures, not a fabricated successful review.

Closing the main desktop window asks for confirmation with the app's branded
icon and explains that active AI work, terminals and warm workers will stop.
**Keep open** is the safe default and does not interrupt work. **Close app**
starts cooperative shutdown; unfinished AI work needs a deliberate retry after
reopening. Verified update/relaunch shutdowns do not ask again.

## Internal scope & IDE AI

Metasessions run with `scope = internal` are **hidden** from feature session
lists, session counts, development rollups, and session SSE — but their usage is
still tailed and credited under the separate **IDE AI** total. Repository
analysis, PR reviews, and automation checks all use internal scope. See
[usage & cost](features/usage-and-cost.md).

## Saved AI operations

Because the recording layer persists every run, unfinished operations are marked
*interrupted* (never silently re-run) on restart, and completed ones are
replayable:

- `GET /meta/operations` — paginated metadata (filter by feature/session/automation).
- `GET /meta/operations/:operationId` — the full stored result.

## See also

- [Agents](agents.md) — how attachable features drive metasessions through a scoped runner.
- [New Task](features/new-task.md) — many metasessions in parallel behind one plan.
- [architecture.md](architecture.md) · [backend-modules.md](backend-modules.md#execution) — where `meta/` sits.
