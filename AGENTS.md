# AGENTS.md — working agreement for this repo

This file orients AI agents (and new humans) working on **AI Project Studio**. Read it fully before making changes. For deeper detail, follow the links into [`docs/`](docs/).

## What this project is

An Electron desktop app that wraps AI coding CLIs (GitHub Copilot, Agency) in an IDE-style workspace organized by **Feature → Session**, with live usage/cost analytics and AI-native features (skills, task plans, summaries). Monorepo with three npm workspaces:

- `backend/` — Express API + domain modules (TypeScript, **ports & adapters**).
- `ui/` — React + Vite front-end.
- `desktop/` — Electron shell that spawns the backend and loads the UI.

## Golden rules (do not violate)

1. **Backend has a 100% coverage gate.** Every backend line/branch/function/statement must be covered or CI fails. Add tests for every change. Run `npm run test:coverage --workspace backend`.
2. **Keep IO at the edges.** Domain logic is pure and testable against **ports** (interfaces). Native/IO adapters (node-pty, node:sqlite, HTTP, fs, process spawning) are thin and excluded from coverage. Don't put logic in adapters.
3. **Dependencies are injected via explicit `deps` objects**, wired only in `backend/src/main.ts` (the composition root). Don't reach for singletons/globals; add a dependency to the relevant `*Deps` interface and wire it in `main.ts`.
4. **Every backend module owns its config** as a `{ NAMESPACE, zodSchema, defaults }` trio in `<module>/config.ts`, registered in `main.ts`. Add config there, never scatter `process.env` reads through the code.
5. **Don't couple the core to a specific CLI.** Copilot/Agency are `provider` adapters behind `IAIProvider`. New tools and user-facing behaviors must go through generic provider/registry hooks — see [docs/adding-a-provider.md](docs/adding-a-provider.md).
6. **Prefer editing existing files** over adding new ones; match the surrounding style. Comment only where intent is non-obvious.
7. **Commit trailers**: include the co-author/session trailers already used in this repo's history when committing.

## Architecture in one screen

```
Electron (desktop/) ── spawns ──▶ Express API (backend/src/api)
        │  loads UI                     │ routes → domain modules
        ▼                               ▼
   React UI (ui/) ◀── HTTP · SSE · WS ── api/usage-stream, controllers
                                        │
  provider registry ─▶ Copilot / Agency CLIs ─▶ CLI session-store.db
                                        │              │ tailed by
  terminal (node-pty) runs the CLI TUI  ▼              ▼
                                usage ─▶ credit ─▶ aggregation ─▶ API ─▶ UI
                                persistence (node:sqlite) ⇦ modules
```

Key primitives live in `backend/src/kernel/` (event bus, clock, ids, logger, typed errors). Live updates flow over an **event bus** (`usage.recorded`, `session.*`) forwarded to the UI via SSE in `api/usage-stream.ts`.

Full detail: [docs/architecture.md](docs/architecture.md) · module reference: [docs/backend-modules.md](docs/backend-modules.md) · UI: [docs/ui-guide.md](docs/ui-guide.md).

## Where things live

| Area | Path |
| --- | --- |
| Composition root (all wiring) | `backend/src/main.ts` |
| HTTP routes & controllers | `backend/src/api/` |
| Provider abstraction & adapters | `backend/src/provider/` (`provider-contract.ts`, `copilot-adapter/`, `agency-adapter/`) |
| Persistence (repos + schema) | `backend/src/persistence/` |
| Shared kernel | `backend/src/kernel/` |
| UI shell (what's actually mounted) | `ui/src/App.tsx` → workspace, skills, settings views |
| UI styles/tokens | `ui/src/styles/` |

> **Dead code warning:** `ui/src/features/feature-board`, `.../feature-detail`, and `.../session-panel` are **not mounted** by `App.tsx`. The live app renders the **workspace**, **skills**, and **settings** views. Don't assume those unmounted components reflect current behavior.

## Common tasks

- **Add an API endpoint** → add a controller in `api/`, register it in `api/routes.ts` (`ApiRoutesDeps` + `createApiRoutes`), wire deps in `main.ts`, test the controller.
- **Add a domain module** → create `<module>/` with a `*-contract.ts` (ports/types), a pure service, a `config.ts` trio, and a repo port if it persists. Wire in `main.ts`. Mirror an existing module like `skills/` or `feature-tasks/`.
- **Add a new CLI tool/provider** → implement `IAIProvider` under `provider/<tool>-adapter/`, register in `main.ts`. See [docs/adding-a-provider.md](docs/adding-a-provider.md).
- **Change persisted shape** → update `persistence/db/schema.ts` + the relevant `*-repo.ts` and its tests.

## Build / test / run

```bash
npm install                                 # once
npm run build                               # backend tsc + ui tsc/vite
npm run test:coverage --workspace backend   # 100% gate — must pass
npm run test:coverage --workspace ui        # UI gate
npm run lint                                # backend typecheck
npm run desktop                             # build + launch Electron
```

Use the **smallest** targeted test while iterating (`npx vitest run <path>` inside `backend/`), then run the full gate before committing. More: [docs/development.md](docs/development.md).

## Environment quirks (important on Windows)

- Backend uses the **experimental `node:sqlite`** module → requires **Node ≥ 22.5**; run backend coverage from **inside `backend/`** (`vitest` has a sqlite shim there).
- On Windows, ConPTY doesn't search PATH/PATHEXT — executables are resolved by `terminal/executable-resolver.ts`. The Copilot CLI is a `.EXE` shim and **requires a valid UUID `--session-id`**.
- PowerShell: use `;` (not `&&`) before PS keywords; multi-line commit messages via here-strings.

## Definition of done

- [ ] Behavior implemented and matches the request.
- [ ] `npm run build` passes (backend + UI typecheck).
- [ ] `npm run test:coverage --workspace backend` passes at 100%.
- [ ] UI tests pass if UI changed.
- [ ] New config/deps wired in `main.ts`; no stray globals.
- [ ] Docs updated if architecture/behavior changed.
