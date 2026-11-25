# Development guide

## Prerequisites
- **Node.js ≥ 24.20.0** for source development/builds; CI and runtime
  provisioning pin **24.20.0**. Packaged users do not need system Node.
- An eligible installed **Copilot**, **Claude Code v2**, or authorized optional
  **Agency** CLI. Installation requires explicit user consent; see [sessions](features/sessions.md).
- Desktop uses **Electron 44.9.3**, 64-bit only, and requires **macOS 13+**.
  Shipped installers target Windows x64 and macOS arm64/x64, not 32-bit systems.

## Install
```bash
npm install    # installs all workspaces
```

## Everyday scripts (run from repo root)
| Command | What it does |
| --- | --- |
| `npm run dev` | Backend (tsx watch) + UI (vite) with hot reload, in the browser. |
| `npm run desktop` | Build backend + UI, then launch the Electron shell. |
| `npm run desktop:dev` | Electron shell pointed at the dev server. |
| `npm run build` | `tsc` build of backend + `tsc`/`vite` build of UI. |
| `npm test` | Backend Vitest suite only (not the UI/native qualification gates). |
| `npm run test:coverage --workspace backend` | Backend test suite with the **100% coverage gate**. |
| `npm run test:coverage --workspace ui` | UI test suite with its coverage gate. |
| `npm run lint` | Backend typecheck (`tsc --noEmit`). |
| `npm run test:perf` | Build and run isolated backend performance/correctness workloads; never starts an AI provider. |
| `npm run test:desktop:harness` | Deterministic Electron lifecycle/preload/update/clipboard contract harness. |
| `npm run test:desktop:smoke` | Isolated packaged-shell smoke; requires a freshly staged/packed build. |

## Tools and CLI configuration

**Settings → Tools & CLIs** is the shared command inventory and editor. The
metadata-only `GET /tools/commands` endpoint references each module's namespace
and safe fields; it does not resolve executables, probe providers, inspect MCP
servers, authenticate or return server environments. The existing typed
`/config/:namespace` save/reset flow remains authoritative, with drafts,
validation and a restart-required notification. Add command metadata in
`backend/src/tools/command-catalog.ts` when adding an application-managed tool.

Executable paths and optional argv stay structured. Session identities, auth
stdin, protocol/JSON arguments, destructive-operation guards and installer
package identities are not general shell templates. Provider schemas validate
required operation prefixes and reserved flags. MCP command/argument definitions
remain in their existing provider-owned MCP editor, linked from this page; no
native server environment or credential is exported. User-entered terminal and
per-automation commands keep their own owners. Internal Node/worker, extraction,
resource-sampling and lifecycle helpers are inventoried read-only.

Git (`git.executable`), GitHub CLI (`githubCli.executable`) and desktop Node
(`desktopRuntime.nodeExecutable`, empty for automatic provisioning) have one
persisted owner each: `<dataDir>/config-overrides/<namespace>.json`. These
namespaces use that file instead of a competing SQLite copy. Desktop reads the
same records before provisioning; the backend routes normal config edits to
them. Restart the **desktop** to apply runtime changes. Legacy `CW_GIT_BIN`,
`CW_GH_BIN` and `CW_NODE_BIN` overrides still win over namespaced environment
variables and persisted settings. `CW_NODE_BIN_OVERRIDE` is an internal relaunch
marker preserving the original legacy override, not an additional user setting.
Managed runtime resolution never becomes a new user override on relaunch.

## Testing

The UI test setup binds storage to jsdom's window so Node's native Web Storage
does not shadow the browser's origin-scoped `localStorage`/`sessionStorage`.
Storage is cleared between tests; no Node storage file or real user profile is
used.

### Backend performance regression gate

Run `npm run test:perf` from the repository root. This builds the backend,
self-tests the measurement/gating code, then mounts the production summary
controller in an isolated loopback HTTP fixture with real SQLite databases and
native history/summary workers. It does **not** import `main.ts`, launch the
desktop, authenticate, or start a provider. The older `scripts/soak.mjs` is
different: it exercises real provider processes and is not run by this gate.

The fixed workload has 300 hierarchical features, 2,400 sessions and 19,200
usage turns, plus an 8 MiB history log. Three mixed rounds run eight summaries
and four history scans each, while unrelated HTTP probes measure responsiveness.
The same workload submits 3,000 records to the real log-writer thread and checks
ordered, exactly-once persistence across rotated files, credential-field
redaction, file-size/retention bounds and confirmed shutdown. A separate native
writer receives an intentionally invalid directory to verify that disk failure
reports unconfirmed persistence instead of success while still confirming exit.
The first summary includes worker startup; later measurements repeat the workload
against warmed files, not a purported cold disk cache. Checks also cover committed
usage freshness, feature reparenting, cancellation recovery, explicit overload
rejection, worker-failure recovery and exact accounting. Queue and worker peaks,
latency percentiles, event-loop delay, RSS, retained heap growth and throughput
are written to `backend/coverage/performance/results.json`, including failures.

Initial Windows x64 / Node 26 measurements were 104 ms for the first summary,
1.16 seconds for the mixed rounds, 2.5 ms loaded HTTP p95, 24.9 ms event-loop p99
and 1.55 MiB retained heap growth. `backend/scripts/performance-budgets.json`
sets deliberately broader CI ceilings: 2 seconds, 10 seconds, 100 ms, 100 ms
and 32 MiB respectively; repeated summaries and history scans also have a
2-second p95 ceiling (initial measurements: 317 ms and 391 ms). The latency
ceilings preserve an interactive budget;
the larger startup/throughput/memory margins accommodate shared CI machines and
different operating systems. These are regression guardrails, not universal
capacity claims or a total-process memory limit. Revisit them using collected
artifacts, not by weakening a failed data-integrity check.

The logging extension measured about 48 ms to enqueue the burst and 1.88 seconds
to persist it in the background on the same Windows machine. The old synchronous
path occupied the API thread for about 1.75 seconds. Enqueue and flush ceilings
are 100 ms and 5 seconds; flush time is not API-thread blocking time. These
extended-workload measurements are separate from the worker-only baseline above.

The large-paste scenario sends a real 4 MiB UTF-8 body through the production
Express body admission, attachment controller/service and asynchronous filesystem
adapter. It verifies exact persisted bytes while probing unrelated HTTP requests.
Budgets are 2 seconds end-to-end, 100 ms health p95 and 100 ms event-loop p99.
The fixture uses no CLI and deletes only its own temporary directory. Renderer
regressions separately verify that oversized paste content never reaches xterm
or PTY input, terminal query replies continue during the input pause, and input
queue byte/frame bounds and prefix-only encoding prevent quadratic work.

For measurement without the quantitative gate, build first and run
`node --expose-gc backend/scripts/performance.mjs --baseline --output=<path>`.
This still checks correctness and reports `baseline-only`, never `pass`.
The separate performance workflow runs on Linux, Windows, macOS Apple Silicon
and Intel, retaining JSON artifacts for 14 days. Local Windows results are not
proof that those other platform jobs have run.

### Durable create operations and deletion

Feature creation, terminal-session creation and agent attachment accept an
`Idempotency-Key` header. Reuse an opaque key only for retries of the same logical
intent and payload, not for independent creations. The resource and replay
response are committed in the same synchronous SQLite unit of work; resolver
awaits stay outside the transaction. Repeating a completed operation returns its
original response, including after process restart. It is a replay snapshot, not
a fresh read of a resource that may since have changed or been deleted.

Different input under one key returns 409 `operation_key_conflict`. A surviving
pending record permits repeating only read-only preparation. The final,
outermost transaction rechecks the key and hash: it replays a concurrent winner,
or writes the resource and completion together once. A missing or replaced
reservation returns 409 `operation_pending` without writing. Nested commits
are refused rather than acknowledged before an outer transaction can roll back.
A confirmed rollback permits retry with the same key. An unconfirmed transaction
poisons that unit of work. The composition root closes the shared native
database handle, invalidating already prepared readers and writers, and the
HTTP admission guard returns 503 `database_restart_required` for non-diagnostic
API routes. `GET /health` and the separately mounted shutdown endpoint remain
reachable. Diagnostics expose the restart requirement, confirmed connection
closure and close failures; an unsuccessful native close is explicitly
unconfirmed, not reported as safe. Direct unit-of-work clients reject further
operations with `operation_connection_unhealthy`. Restart is required; the
backend does not automatically restart itself or any AI provider.
Legacy callers without a key retain
their previous create behavior and do not gain retry protection automatically.

The `clientOperations` config fixes the header to `idempotency-key` for protocol
compatibility, and owns key length (128 by default, minimum 64), succeeded
replay retention (24 hours), record cap (10,000) and pruning batch (500).
Unresolved records are never pruned to fit capacity; a full store returns 503
`operation_capacity` rather than guessing that a create failed. This protection
is bounded, not a forever guarantee after succeeded keys expire. Resolve an
unknown outcome before deliberately starting a new intent.

Session purge retains usage and removes its live billing/session rows in one
unit of work. An intermediate repository failure rolls the synchronous changes
back together, preventing double-counted live-plus-retained totals. External
quiescence and cleanup remain outside that transaction.

### Non-blocking file logging

File logging defaults to a dedicated writer thread while console delivery stays
independent. The `logging` config owns the bounded queue (4,096 records / 8 MiB),
batch size (256), flush interval (50 ms), acknowledgement deadline (5 seconds)
and restart budget (3). Existing daily rotation, size, retention and bounded
record formatting still apply. The generic worker termination deadline is
`backgroundWork.terminateTimeoutMs` (5 seconds).

Unacknowledged writes are counted as **unconfirmed**, never blindly replayed.
A writer whose physical exit is unconfirmed quarantines that file: no
replacement or synchronous fallback touches it until exit is proved. Rejected,
overflowed, serialization-failed and unavailable records have explicit counters;
overflow also emits a marker when capacity returns. A confirmed-dead writer may
use a synchronous degraded fallback, so that exceptional mode can block the API
and is not advertised as normal async delivery. A failed disk write never
increments the confirmed fallback-written count.

The resources/health payload exposes queue state and counters plus sink/file
failure reports and failed last-resort diagnostic writes. Sink failures do not
escape into application callers or starve sibling sinks. Shutdown drains and
confirms workers within deadlines; an unconfirmed drain is reported as failure,
not clean shutdown. These mechanisms surface disk exhaustion or broken output
channels; they cannot guarantee log persistence when storage is unavailable.
`flush()` reports accepted-record persistence; `close()` independently reports
physical worker exit. Historical write failures keep `persistenceConfirmed`
false, but do not prevent shutdown forever once the worker has truly exited.

### Resource monitoring and safe cleanup

`GET /resources` (under the configured API base path) returns cached app process
and storage measurements; independent host pressure remains in `GET /health`.
The wire shape mirrors `ui/src/features/resources/resource-types.ts`.
App CPU is the sum of process CPU-time
deltas divided by elapsed time **and the host logical CPU count** (100% means
the whole host). New processes need two samples; partial app CPU totals are
reported as null, while measured per-process rows remain available.
Process identity includes PID and creation time. The desktop
passes its PID to include main, renderer, GPU/utility and backend/CLI descendants.
Windows is currently supported for process-tree sampling; other platforms report
it unavailable without hiding the independent host-pressure measurements.
Memory is summed working set/RSS, not private committed memory: shared pages can
appear in multiple processes. Neither metric represents host pressure.

`POST /resources/storage/refresh` starts one coalesced, bounded background scan
and immediately returns the same snapshot shape with `storage.status: "scanning"`;
GET requests never walk the filesystem or spawn process probes. The `resources`
config namespace controls sample interval, stale windows, process timeout, and
storage scan scheduling. `processSamplingEnabled` defaults to true; disabling
it skips app process-tree/CIM sampling but leaves independent host pressure
available. `scanTimeoutMs` bounds discovery/cleanup operations, not the complete
resumable traversal; `maxScanEntries` caps cleanup entries and the hardlink
identity index, not the number of files an inventory may contain.
Directory traversal keeps resumable per-root
cursors and rotates after at most 64 entries or 25ms of cooperative work, yielding
the event loop between slices. Large worktrees no longer exhaust a global
30-second timer or starve later app/provider roots. Refreshes coalesce with the
ongoing scan rather than resetting its progress. `maxScanDurationMs` bounds the
whole inventory (default **300,000 ms**); expiry preserves measured bytes and
marks unfinished paths partial instead of claiming complete totals. Traversal
also stops on cancellation/shutdown; root count (256), depth (128) and the
hardlink identity index (`maxScanEntries`) bound retained state. Scans expose progress, timestamps, nullable sizes,
per-path errors, volume capacity/free/available bytes, and incomplete results.
Sizes are logical file bytes, not allocated blocks. Scoped app data/install,
managed worktree, provider, cache and log roots are de-duplicated across categories
and hardlinks; junctions/symlinks are skipped and recorded as expected exclusions,
not fabricated scan failures. Duplicate normalized roots likewise do not add
errors. The desktop supplies scoped runtime roots for Electron, backend/UI
builds and dependencies, without scanning the entire repository or profile.
Provider files may be shared by
other apps and are not evidence of exclusive Studio ownership.

`POST /resources/cleanup` accepts **only** `{ "category": "logs" | "cache" }`,
never caller-supplied paths. Logs cleanup removes only configured managed log
filenames in a dedicated app-data log directory, older than both backend startup
and its startup UTC day; links, changed files, current logs, foreign files and
subdirectories are preserved. Cleanup immediately returns a `ResourceCleanup`
job; progress and completion are available in `GET /resources`'s `cleanups`
array. Cleanup cancels an active inventory scan rather than waiting indefinitely
behind it; duplicate requests coalesce, and busy/unsupported requests return
explicit failed jobs. History retains at
most ten jobs. No HTTP handler waits for deletion or scanning. Live Electron cache cleanup is unsupported:
its caches may be in use, so no raw recursive deletion is attempted. Worktrees,
provider installs, sessions, databases, config, prompts and the user's shared
checkout are never removed by these endpoints. No cleanup runs automatically.

The desktop bridge separately offers `desktopBridge()?.clearHttpCache()` after
explicit UI confirmation. It invokes Electron `session.defaultSession.clearCache()`
only, coalesces concurrent requests, and returns `{status, scope:
"electron-http-cache", completedAt, error}`. It accepts no paths/options and
requires a trusted top-level sender. This is **Electron HTTP cache only**, not
provider caches, code caches, cookies, authentication, storage or session history.
No reclaimed-byte estimate is fabricated. Older desktop shells lack this optional
capability and must show it as unavailable.

Managed-worktree removal separately checks live terminals/running sessions,
queued application producer scopes, and unfinished or physically unconfirmed
metasessions. Primary checkouts are always protected. When a producer has not
published an exact checkout, removal conservatively protects its repository's
managed worktree directory; retry after that producer finishes. Deletion
callbacks do not count as producers, avoiding self-blocking teardown.

### Non-blocking background work

Use `kernel/background-work-runner.ts` for CPU-intensive operations and keep
native worker creation in an IO adapter. Declaring a handler `async` does not
prevent synchronous parsing or regular-expression backtracking from blocking
every API on that process.

The `backgroundWork` config bounds active workers (default **1**), queued work
(**16**), total queue-plus-execution deadline (**60 seconds**) and per-worker
old-generation heap (**256 MB**, not a total-process memory cap).
Cancel replaced/deleted jobs; release slots only after worker termination.
Queue saturation and deadlines fail the affected job with actionable messages.
Send real phase/progress events, throttled before persistence, rather than
invented percentages. Keep interactive requests outside the CPU queue.

Regression tests exercise two deliberately stuck CPU workers while health and
session endpoints remain responsive. New expensive features should add the same
isolation/deadline/cancellation checks; never mask stalls by increasing HTTP
timeouts.

- Framework: **Vitest** in both `backend/` and `ui/`.
- **Backend coverage is 100%** (lines/branches/functions/statements) — see `backend/vitest.config.ts`. New code must be fully covered or CI fails.
- The backend coverage script uses a single fork
  (`--poolOptions.forks.singleFork=true`); use the workspace script for the
  authoritative gate rather than assuming an arbitrary Vitest invocation has
  the same execution policy. Excluded IO adapters and native behavior still need
  their own contract/native qualification; 100% does not mean every file is gated.
- Iterate fast with a targeted run, then run the full gate before committing:
  ```bash
  cd backend
  npx vitest run src/terminal/terminal-manager.test.ts   # one file
  npx vitest run --coverage                               # full gate (run inside backend/)
  ```
- **Run backend coverage from inside `backend/`.** `node:sqlite` needs a vitest shim configured there; running `--coverage` from the repo root fails to load sqlite.
- UI coverage targets `ui/src/lib` — keep logic there testable.
- Packaged-shell regression foundation: `npm run test:desktop:harness` and
  `npm run test:desktop:smoke` — see [isolation, manifests and scope limits](desktop-regression.md).
  The smoke refuses old packages lacking its synthetic-backend isolation seam;
  it is not permission to launch a development app against a live profile.

## Frozen packaged runtime

After building, `npm run stage --workspace desktop` copies the compiled backend,
UI and documentation into `desktop/build`. The backend staging directory also
retains the committed root lockfile byte-for-byte and each workspace manifest,
so dependency installation uses the same resolution graph as repository CI:

```powershell
Set-Location desktop\build\backend
npm ci --omit=dev --workspace backend --include-workspace-root=false --no-audit --no-fund
```

Do not substitute `npm install` or regenerate a standalone backend lockfile
during packaging. Update dependencies and the committed workspace lockfile in
the source tree first. The staged root manifest adds `type: module` so the
existing `dist/main.js` entrypoint keeps its ESM semantics; runtime dependency
versions still come exclusively from the committed lock graph.

The desktop harness checks staging and ESM execution. An offline installation
with scripts disabled can check graph consistency, but **does not qualify native
dependencies or the packaged application**. Release installation enables lifecycle
scripts; native/installer and supported-platform qualification remain separate.

## Native dependency installation

CI and installer builds use Node.js 24.20.0. Its SQLite module no longer emits
the experimental warning produced by older supported Node runtimes. The
workflow uses Node-24-compatible GitHub Actions rather than forcing retired
action runtimes or suppressing their warnings.

Root/backend engines require **Node.js ≥ 24.20.0**; use the pinned CI version for
reproducible builds. The desktop provisions the backend runtime independently of
system Node. Explicit desktop runtime overrides must also meet **24.20.0**;
older API compatibility floors are not supported-runtime promises.

On macOS, the backend's installation hook restores executable permission on
`node-pty`'s native spawn helper (the 1.1.0 npm tarball ships it as `0644`).
Runtime staging includes the hook so both workspace installs and the packaged
backend's production dependency install apply the same repair.

## Code signing

Installers are built by the **Release prerelease** workflow (`.github/workflows/release.yml`) when you push a `v*` tag or dispatch it manually. Verification includes Windows, macOS, and Linux; both shipped installer platforms depend on the complete verification matrix. Manual dispatch retains internal candidates only. A tag push publishes the exact candidate installers as an explicitly **unqualified GitHub prerelease** after every verification and build job succeeds. Signing depends on the configured service; publication is never proof of qualification. Only the publication job has repository write permission; it checks artifact hashes and provenance, uploads through a draft, and never marks the prerelease latest.

Ordinary CI and release verification run on native Apple Silicon (`macos-15`)
and Intel (`macos-15-intel`) runners in addition to Windows and Linux. Release
builds produce separate `arm64` and `x64` Mac installers on matching native hosts,
so staged native dependencies are not accidentally copied from another architecture.

Each artifact bundle includes `candidate-<platform>-<arch>.json` with the exact source SHA, platform/architecture, CI run/attempt, unchanged staged-lock hash, and installer/feed hashes and sizes. The recorded Node version/ABI describes the **build host**, not proof of the packaged runtime. Native runtime, signature, and release qualification are explicitly pending.

The publication job keeps Windows and both Mac architecture downloads in separate directories.
Shared filenames such as `builder-debug.yml` must not overwrite each other before
each platform/architecture manifest is verified. Only installers and provenance manifests
are published; diagnostic files and update feeds remain internal artifacts.

**Channel policy:** unsigned or unqualified builds may be distributed as explicitly labeled prereleases, not stable production releases. The candidate manifests retain their build-stage channel and qualification/signature status; publication does not qualify them. Production promotion still requires signature verification (Windows signing; macOS Developer ID signing and notarization), packaged/native and upgrade/restore evidence for every shipped platform, and results tied to these exact artifact hashes. Promote the qualified bytes without rebuilding; a changed artifact invalidates its qualification. There is no automatic stable promotion path while these gates remain open.

### Windows — Azure Trusted Signing
Signed automatically **when all signing settings are configured**. If every setting is absent, the workflow may emit an explicitly unsigned internal candidate; partial configuration fails rather than silently falling back to unsigned output. A configured signing build is not itself signature-verification evidence. electron-builder's native `win.azureSignOptions` support installs the `TrustedSigning` PowerShell module on the runner and signs packaged executables — no certificate files or hardware tokens required.

One-time setup:
1. In Azure, create a **Trusted Signing account** + a **certificate profile**, and complete identity validation.
2. Create a **Microsoft Entra ID app registration** (service principal) and grant it the **Trusted Signing Certificate Profile Signer** role on the account.
3. Add these **GitHub Actions secrets** (Settings → Secrets and variables → Actions):

   | Secret | Example / meaning |
   | --- | --- |
   | `AZURE_TENANT_ID` | Entra tenant (directory) ID |
   | `AZURE_CLIENT_ID` | Service-principal application ID |
   | `AZURE_CLIENT_SECRET` | Service-principal client secret |
   | `AZURE_CODE_SIGNING_ENDPOINT` | Region endpoint, e.g. `https://eus.codesigning.azure.net` |
   | `AZURE_CODE_SIGNING_ACCOUNT` | Trusted Signing account name |
   | `AZURE_CODE_SIGNING_PROFILE` | Certificate profile name |

The first three authenticate via `azure.identity` `EnvironmentCredential`; the last three are injected as `-c.win.azureSignOptions.*` overrides at build time, so nothing is hardcoded in `electron-builder.yml`.

> SmartScreen reputation for Trusted Signing certs builds over time/downloads; a brand-new certificate profile may still warn on the first few installs even though the publisher is now shown as verified.

### Windows — SignPath Foundation (free, open source)
A **free**, Windows-trusted alternative to Azure Trusted Signing for public open-source projects, via the [SignPath Foundation](https://signpath.org/). The private key never touches CI: the workflow uploads the unsigned `.exe`, SignPath signs it in a managed cloud workflow, and the signed `.exe` is written back into `desktop/release/` **before** the provenance hash is recorded. Both required SignPath secrets must be present; partial configuration fails closed. With no SignPath settings, Windows uses fully configured Azure signing or the explicitly unsigned candidate path. Configuring both signing services fails; pick one.

One-time setup:
1. Apply to the **SignPath Foundation** open-source program and have them create (or link) a SignPath organization for this repo. The certificate is issued to *"SignPath Foundation"*, so that's the publisher Windows shows — a real OV signature that clears the "Unknown Publisher" block.
2. In SignPath, create a **project** and configure its slugs to match the workflow:

   | Workflow input | Value (must match SignPath project) |
   | --- | --- |
   | `project-slug` | `ai-project-studio` |
   | `signing-policy-slug` | `release-signing` |
   | `artifact-configuration-slug` | `windows-exe` |

   (Adjust the three literals in `release.yml` if your SignPath project uses different slugs.)
3. Add these **GitHub Actions secrets**:

   | Secret | Meaning |
   | --- | --- |
   | `SIGNPATH_ORGANIZATION_ID` | SignPath organization GUID (also the enable flag) |
   | `SIGNPATH_API_TOKEN` | SignPath CI user API token |

> The **first** signing request for a new policy may require a one-time manual approval in the SignPath UI; with `wait-for-completion: true` the job blocks until it's approved (or times out). Approve it once and subsequent releases are automatic.

### macOS — ad-hoc (free, default) or Developer ID + notarization (paid)
The free default remains an **ad-hoc signature** (`mac.identity: '-'`): valid enough that Apple Silicon no longer reports the download as "damaged", but un-notarized, so Gatekeeper still shows the "unidentified developer" prompt that clearing the quarantine flag (`xattr -dr com.apple.quarantine …`) resolves. This path is **not eligible for production promotion**.

The workflow also supports **Developer ID signing + Apple notarization**. This
requires paid Apple Developer Program membership. All five Apple secrets must
be present; partial configuration **fails closed**, rather than silently using
ad-hoc signing. A normal macOS first-launch confirmation can still appear:

   | Secret | Meaning |
   | --- | --- |
   | `APPLE_CSC_LINK` | Base64 of the **Developer ID Application** `.p12` (`base64 -i cert.p12`) |
   | `APPLE_CSC_KEY_PASSWORD` | Password for that `.p12` |
   | `APPLE_ID` | Apple ID email used for notarization |
   | `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for that Apple ID |
   | `APPLE_TEAM_ID` | Apple Developer Team ID |

When set, the macOS build overrides the ad-hoc identity with the imported Developer ID, enables Hardened Runtime, signs the DMG, and submits to Apple's notary service via `notarytool`. The configured workflow verifies native signing/Gatekeeper/notarization evidence with `codesign`, `spctl` and stapling checks. These are workflow requirements, not a claim that signing was run locally. Production promotion still requires the resulting exact-artifact evidence and native install/upgrade qualification; bypassing Gatekeeper is not qualification.

## Auto-update
The desktop uses a **custom GitHub Releases updater** in
`desktop/update-manager.cjs`, not `electron-updater`. The renderer uses
`window.desktop.updates`, `ui/src/hooks/use-app-updates.ts`, and
`ui/src/lib/update-state.ts`. Tests of those contracts do not certify a live
download, signature, installer, account or native upgrade.

**How it flows**
- Packaged startup and periodic checks discover eligible releases. The app
  notifies first; downloading and installing require explicit user actions.
- **Windows:** release metadata must identify the exact expected version,
  platform, architecture, installer and SHA-256. Download bytes must pass this
  integrity gate before handoff, and OS-valid Authenticode must match a locally
  pinned signer fingerprint or exact full subject. Missing pins, pending/unqualified manifests or
  mismatched metadata fail closed; an arbitrary co-published checksum does not
  establish trust. Before relaunch,
  the renderer is signalled to preserve work and backend shutdown is coordinated.
  The shipped trust-pin set is currently empty, so this policy intentionally
  blocks automatic Windows installer handoff until release trust is configured;
  a published unqualified prerelease is not sufficient.
  Packaged `updateTrust` owns `requireAuthenticode`, `signerThumbprints` and
  `signerSubjects`; a downloaded manifest cannot supply trust pins. The schema-1
  candidate must match the release version, platform, architecture, artifact
  name, SHA-256 and byte size, with `qualification: "passed"` and, for signed
  candidates, `signatureVerification: "passed"`. The current generator's pending
  qualification state is deliberately insufficient for automatic installation.
  Release checks validate that manifest before offering automatic installation.
  Missing trust or qualification is shown in the update banner and Settings;
  the sole guided action opens the release page without downloading an
  installer, stopping the backend, or quitting. Installer bytes and signatures
  are still checked again at download and execution boundaries.
- **macOS:** release detection/notes and guided download/install remain the
  supported path, including when signed. There is no promised automatic ZIP,
  Squirrel, blockmap or differential installation.
- **Surfaces:** a dismissible top banner (`features/updates/update-banner.tsx`) and a **Settings ▸ About ▸ Software updates** section (`features/updates/software-update-section.tsx`) showing current/available version, a "Check for updates" action, release notes, live progress, and Install.

**Requirements for updates to resolve**
- The custom manager's eligible GitHub release assets and trusted per-platform/
  architecture manifest must agree. Builder-generated `.yml`/`.blockmap`
  artifacts are not this manager's authentication or qualification boundary.
- Tag publication creates an explicitly unqualified prerelease, not automatic
  stable/update approval. Preserve exact artifact hashes on qualified promotion.
- Offline checks, absent metadata, invalid downloads and installer errors leave
  the current app running with a non-fatal reported outcome.

**Local testing:** use the deterministic desktop harness for updater contracts.
Any opt-in real-feed simulation is an external-network check, not native
installer qualification; do not run it against a live profile as a unit test.

## Debugging the desktop app
- `npm run desktop` prints backend logs prefixed with `[backend]`, including the dynamic API port (`… API listening on http://127.0.0.1:<port>/api`).
- Verify the backend is up: `curl http://127.0.0.1:<port>/api/providers`.
- AI readiness waits for the selected CLI, not an unrelated CLI's pending
  checks. A failed readiness request shows its reason and **Refresh automation
  readiness** directly; an unknown status is not reported as missing CLI setup.
- Main and detached windows recover from renderer crashes without restarting the
  backend. Two consecutive automatic reloads are allowed; further crashes show a
  lightweight **Reload interface** page instead of looping. A healthy app load
  resets the budget after one minute. Unresponsive windows offer **Wait** or
  **Reload interface**; unsent input can be lost when reloading. Renderer exit
  reasons and recovery failures survive restart in the bounded
  `<userData>/logs/desktop-renderer.log`.
- Kill a stray Electron: find the PID (`Get-Process electron`) and `Stop-Process -Id <pid>`.

## Environment quirks
- **Windows/ConPTY:** node-pty doesn't search PATH/PATHEXT; `terminal/executable-resolver.ts` resolves executables. The Copilot CLI is a `.EXE` shim and **rejects a non-UUID `--session-id`** ("not a valid UUID").
- **PowerShell:** use `;` not `&&` before PS keywords; each command runs in a fresh process (no persisted cwd/env).
- Module config uses **`CW__<namespace>__<key>`** environment variables,
  validated by each module's schema. `CW_LOG_LEVEL` is a special legacy override,
  not the general naming pattern. Saved overrides are restart-gated unless the
  owning module explicitly provides a safe live operation.

## Commit & PR conventions
- Conventional-commit style subjects (`feat(scope):`, `fix(scope):`, `docs:`…).
- Include the repo's co-author/session commit trailers.
- Keep commits build- and test-green; CI runs build, both coverage gates and
  `test:desktop:harness` on its configured push/PR triggers.
