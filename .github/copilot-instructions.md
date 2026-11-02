# Copilot coding agent instructions

This repository is **AI Project Studio** — an Electron/React/Express monorepo (workspaces: `backend/`, `ui/`, `desktop/`).

**Read [`AGENTS.md`](../AGENTS.md) first** — it is the canonical working agreement. Then use [`docs/`](../docs/) for details.

Non-negotiables:
- Backend has a **100% test coverage gate** — add tests for every change and run `npm run test:coverage --workspace backend`.
- Backend follows **ports & adapters**; all wiring happens in `backend/src/main.ts`. Inject dependencies via `*Deps` objects; don't add globals.
- Each module owns its config (`<module>/config.ts`: namespace + zod schema + defaults).
- Keep the core **provider-agnostic** — Copilot, optional Agency, and Claude are adapters behind `IAIProvider`; add tools/behaviors via generic hooks (see `docs/adding-a-provider.md`).
- `ui/src/App.tsx` mounts **workspace, planner, skills, MCP, automations, usage, agents, and settings**; `feature-board`, `feature-detail`, and `session-panel` are legacy, unmounted code.
- Use the **Node 24.20.0** source-build/CI pin; packaged desktop builds provision their own backend runtime.

Validate before finishing:
```bash
npm run build
npm run test:coverage --workspace backend
npm run test:coverage --workspace ui
```
