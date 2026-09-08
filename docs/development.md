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

On macOS, the backend's installation hook restores executable permission on
`node-pty`'s native spawn helper (the 1.1.0 npm tarball ships it as `0644`).
Runtime staging includes the hook so both workspace installs and the packaged
backend's production dependency install apply the same repair.

## Code signing

Installers are built by the **Release prerelease** workflow (`.github/workflows/release.yml`) when you push a `v*` tag or dispatch it manually. Verification includes Windows, macOS, and Linux; both shipped installer platforms depend on the complete verification matrix. Manual dispatch retains internal candidates only. A tag push publishes the exact candidate installers as an explicitly unsigned, unqualified GitHub prerelease after every verification and build job succeeds. Only the publication job has repository write permission; it checks artifact hashes and provenance, uploads through a draft, and never publishes update-feed assets or marks the prerelease latest.

Each artifact bundle includes `candidate-<platform>.json` with the exact source SHA, CI run/attempt, unchanged staged-lock hash, and installer/feed hashes and sizes. The recorded Node version/ABI describes the **build host**, not proof of the packaged runtime. Native runtime, signature, and release qualification are explicitly pending.

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

### macOS — unsigned (for now)
The current `.dmg` candidate is unsigned and un-notarized (`dmg.sign: false`, `CSC_IDENTITY_AUTO_DISCOVERY=false`) and is **not eligible for production promotion**. Gatekeeper may block first launch. Production requires Apple Developer Program enrollment, a **Developer ID Application** certificate, signing/notarization configuration, and verification of the resulting artifact; bypassing Gatekeeper is not qualification.

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
