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

## Code signing

Installers are built by the **Release** workflow (`.github/workflows/release.yml`) when you push a `v*` tag.

### Windows — Azure Trusted Signing
Signed automatically **when the repo has the signing secrets configured**; otherwise the workflow still succeeds and emits an unsigned installer (with a warning). electron-builder's native `win.azureSignOptions` support installs the `TrustedSigning` PowerShell module on the runner and signs every packaged executable — no certificate files or hardware tokens required.

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
There is **no Apple Developer Program membership**, so the `.dmg` ships unsigned and un-notarized (`dmg.sign: false`, `CSC_IDENTITY_AUTO_DISCOVERY=false`). Gatekeeper will block first launch; the user workaround is documented in the README "Releases" section. To make the error go away for good, join the Apple Developer Program ($99/yr), obtain a **Developer ID Application** certificate, and add signing + notarization (`@electron/notarize`) to the macOS build.

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
