# Copilot coding agent instructions

This repository is **AI Project Studio** — an Electron/React/Express monorepo (workspaces: `backend/`, `ui/`, `desktop/`).

**Read [`AGENTS.md`](../AGENTS.md) first** — it is the canonical working agreement. Then use [`docs/`](../docs/) for details.

Non-negotiables:
- Backend has a **100% test coverage gate** — add tests for every change and run `npm run test:coverage --workspace backend`.
- Backend follows **ports & adapters**; all wiring happens in `backend/src/main.ts`. Inject dependencies via `*Deps` objects; don't add globals.
- Each module owns its config (`<module>/config.ts`: namespace + zod schema + defaults).
- Keep the core **provider-agnostic** — Copilot/Agency are adapters behind `IAIProvider`; add tools/behaviors via generic hooks (see `docs/adding-a-provider.md`).
- `ui/src/App.tsx` mounts only the **workspace, skills, and settings** views; `feature-board`, `feature-detail`, and `session-panel` are dead code.

Validate before finishing:
```bash
npm run build
npm run test:coverage --workspace backend
npm run test:coverage --workspace ui
```
