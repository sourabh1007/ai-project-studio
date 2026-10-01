# Development guide

## Prerequisites
- **Node.js ≥ 22.5** (backend uses the built-in `node:sqlite`).
- **GitHub Copilot CLI** and/or **Agency CLI** on your `PATH`.

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
| `npm run test:coverage --workspace backend` | Backend test suite with the **100% coverage gate**. |
| `npm run test:coverage --workspace ui` | UI test suite with its coverage gate. |
| `npm run lint` | Backend typecheck (`tsc --noEmit`). |

## Testing

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
storage inventory deadlines. Directory traversal keeps resumable per-root
cursors and rotates after at most 64 entries or 25ms of cooperative work, yielding
the event loop between slices. Large worktrees no longer exhaust a global
30-second timer or starve later app/provider roots. Refreshes coalesce with the
ongoing scan rather than resetting its progress. Traversal continues until all
roots finish or shutdown cancels it; root count (256), depth (128) and the
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
array. One bounded job waits behind an existing scan, duplicate requests coalesce,
and busy/unsupported requests return explicit failed jobs. History retains at
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

Development tooling requires Node.js 22.12 or newer; use the pinned CI version
for reproducible local builds. The installed backend's minimum runtime remains
Node.js 22.5.

On macOS, the backend's installation hook restores executable permission on
`node-pty`'s native spawn helper (the 1.1.0 npm tarball ships it as `0644`).
Runtime staging includes the hook so both workspace installs and the packaged
backend's production dependency install apply the same repair.

## Code signing

Installers are built by the **Release prerelease** workflow (`.github/workflows/release.yml`) when you push a `v*` tag or dispatch it manually. Verification includes Windows, macOS, and Linux; both shipped installer platforms depend on the complete verification matrix. Manual dispatch retains internal candidates only. A tag push publishes the exact candidate installers as an explicitly unsigned, unqualified GitHub prerelease after every verification and build job succeeds. Only the publication job has repository write permission; it checks artifact hashes and provenance, uploads through a draft, and never publishes update-feed assets or marks the prerelease latest.

Each artifact bundle includes `candidate-<platform>.json` with the exact source SHA, CI run/attempt, unchanged staged-lock hash, and installer/feed hashes and sizes. The recorded Node version/ABI describes the **build host**, not proof of the packaged runtime. Native runtime, signature, and release qualification are explicitly pending.

The publication job keeps Windows and macOS downloads in separate directories.
Shared filenames such as `builder-debug.yml` must not overwrite each other before
each platform's manifest is verified. Only installers and provenance manifests
are published; diagnostic files and update feeds remain internal artifacts.

**Channel policy:** unsigned or unqualified builds may be distributed as explicitly labeled prereleases, not stable production releases. Version 0.11.0 uses this user-authorized unsigned distribution path. The candidate manifests retain their build-stage internal channel and pending qualification/signature status; publication does not qualify them. Production promotion still requires signature verification (Windows signing; macOS Developer ID signing and notarization), packaged/native and upgrade/restore evidence for every shipped platform, and results tied to these exact artifact hashes. Promote the qualified bytes without rebuilding; a changed artifact invalidates its qualification. There is no automatic stable promotion path while these gates remain open.

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
A **free**, Windows-trusted alternative to Azure Trusted Signing for public open-source projects, via the [SignPath Foundation](https://signpath.org/). The private key never touches CI: the workflow uploads the unsigned `.exe`, SignPath signs it in a managed cloud workflow, and the signed `.exe` is written back into `desktop/release/` **before** the provenance hash is recorded — so the published, hash-verified artifact is the signed one. Enabled automatically when the SignPath secrets are present; absent, Windows falls back to the Azure path (or an unsigned internal candidate). Don't configure both Azure and SignPath — pick one.

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

The workflow now **also** supports full **Developer ID signing + Apple notarization**, which removes the Gatekeeper prompt entirely. This requires a **paid Apple Developer Program** membership ($99/yr) — there is no free notarization path. It activates automatically when all five Apple secrets are set (partial configuration leaves the free ad-hoc default in place):

   | Secret | Meaning |
   | --- | --- |
   | `APPLE_CSC_LINK` | Base64 of the **Developer ID Application** `.p12` (`base64 -i cert.p12`) |
   | `APPLE_CSC_KEY_PASSWORD` | Password for that `.p12` |
   | `APPLE_ID` | Apple ID email used for notarization |
   | `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for that Apple ID |
   | `APPLE_TEAM_ID` | Apple Developer Team ID |

When set, the macOS build overrides the ad-hoc identity with the imported Developer ID, enables Hardened Runtime, signs the DMG, and submits to Apple's notary service via `notarytool`. Production promotion still requires verifying the resulting notarized artifact — bypassing Gatekeeper is not qualification.

## Auto-update
The desktop app self-updates from **GitHub Releases** using [`electron-updater`](https://www.electron.build/auto-update). The main-process wrapper is `desktop/update-manager.cjs`; the renderer talks to it through the `window.desktop.updates` preload bridge and the `ui/src/hooks/use-app-updates.ts` hook (all update-view logic lives in the fully-tested `ui/src/lib/update-state.ts` reducer).

**How it flows**
- On launch (packaged only) the app checks for updates after a short delay, then every ~4h. `autoDownload=false` — the user is **notified first**, downloads on consent, and installs with one click. `autoInstallOnAppQuit=true` applies a deferred update on next quit.
- **Windows (signed NSIS):** full flow — detect → in-app notify → progress download (blockmap/differential) → `quitAndInstall`. Before relaunch the app emits `update:before-quit` to the renderer (persist work) and calls `stopBackend()`.
- **macOS (unsigned DMG):** Squirrel.Mac can't install unsigned updates, so the manager degrades gracefully to a lightweight GitHub Releases API check (detect + release notes + guided install via the release page). `canAutoInstall=false` is surfaced to the UI. This becomes a full flow once macOS signing/notarization lands.
- **Surfaces:** a dismissible top banner (`features/updates/update-banner.tsx`) and a **Settings ▸ About ▸ Software updates** section (`features/updates/software-update-section.tsx`) showing current/available version, a "Check for updates" action, release notes, live progress, and Install.

**Requirements for updates to resolve**
- `electron-builder.yml` has a `publish` github provider (`owner: sourabh1007`, `repo: ai-project-studio`) so `latest.yml` / `latest-mac.yml` update-feed metadata is generated.
- The candidate workflow retains `desktop/release/*.yml` (feed metadata) and `*.blockmap` alongside installers as internal artifacts. Only a qualified promotion may publish those exact files to GitHub Releases; `electron-updater` needs the `.yml` to find the newest release.
- Every backend failure path is wrapped so a broken/absent feed, offline state, or older release degrades to a quiet no-op and never breaks the app.

**Local testing:** set `CW_UPDATE_SIM=1` to exercise the update path against the real GitHub feed in a dev (unpackaged) build; `desktop/dev-app-update.yml` supplies the dev feed config.

## Debugging the desktop app
- `npm run desktop` prints backend logs prefixed with `[backend]`, including the dynamic API port (`… API listening on http://127.0.0.1:<port>/api`).
- Verify the backend is up: `curl http://127.0.0.1:<port>/api/providers`.
- Kill a stray Electron: find the PID (`Get-Process electron`) and `Stop-Process -Id <pid>`.

## Environment quirks
- **Windows/ConPTY:** node-pty doesn't search PATH/PATHEXT; `terminal/executable-resolver.ts` resolves executables. The Copilot CLI is a `.EXE` shim and **rejects a non-UUID `--session-id`** ("not a valid UUID").
- **PowerShell:** use `;` not `&&` before PS keywords; each command runs in a fresh process (no persisted cwd/env).
- Config comes from env with the **`CW`** prefix (e.g. `CW_LOG_LEVEL`), validated per-module.

## Commit & PR conventions
- Conventional-commit style subjects (`feat(scope):`, `fix(scope):`, `docs:`…).
- Include the repo's co-author/session commit trailers.
- Keep commits build- and test-green; CI runs build + both coverage gates on every push/PR to `main`.
