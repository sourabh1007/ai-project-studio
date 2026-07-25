# UI guide

The UI is a React + Vite SPA in `ui/`. It talks to the backend over HTTP (REST), Server-Sent Events (live usage/session updates), and a WebSocket (interactive terminal).

## What's actually mounted

`ui/src/App.tsx` renders three top-level views:

- **Workspace** (`features/workspace/`) — the IDE shell: explorer sidebar, session tabs, embedded terminal, new-session form, import-session panel, feature dashboard tabs.
- **Skills** (`features/skills/`) — manage/tag reusable instruction skills.
- **Settings** (`features/settings/`) — app configuration.

> **Not mounted (legacy/dead):** `features/feature-board/`, `features/feature-detail`, and `features/session-panel/` are not reachable from `App.tsx`. Treat them as historical; don't rely on them for current behavior.

## Feature areas (`ui/src/features`)

| Area | Purpose | Mounted? |
| --- | --- | --- |
| `workspace/` | IDE shell: `workspace-view.tsx`, `explorer.tsx`, `new-session-form.tsx`, `import-session-panel.tsx`. | ✅ |
| `feature-dashboard/` | Feature analytics: charts, `feature-tasks-panel.tsx`, `work-summary.tsx`. | ✅ (within workspace) |
| `skills/` | `skills-manager.tsx`, `skill-tagger.tsx`, `skill-chips.tsx`, `skill-kind.tsx`. | ✅ |
| `settings/` | `settings-view.tsx`. | ✅ |
| `usage-dashboard/` | Charts/rollups for usage & credits by model/provider/day. | ✅ (within workspace) |
| `live-credit-meter/` | Live per-session credits/tokens meter. | ✅ (within workspace) |
| `feature-summary/` | Generate/show AI feature summaries. | partial |
| `feature-board/`, `session-panel/` | Legacy list/detail views. | ❌ |

## Shared folders

| Folder | Contents |
| --- | --- |
| `app/` | API context / shared API client wiring (`api-context.ts`). |
| `components/` | Reusable primitives: `ui.tsx`, `icons.tsx`, `terminal-view.tsx`, `model-picker.tsx`, `provider-picker.tsx`. |
| `hooks/` | Data + live-stream hooks: `use-usage-stream.ts`, `use-workspace-stats.ts`, `use-ide-usage.ts`, `use-async.ts`. |
| `lib/` | API client + helpers: `api.ts`, `stream.ts`, `types.ts`, `format.ts`. Tested; UI coverage gate targets `lib/`. |
| `styles/` | `design-tokens.css`, `app.css`. Use existing CSS variables/tokens; avoid undefined vars. |

## Conventions

- Keep testable logic in `lib/` (parsing, formatting, stream state) — that's where the UI coverage gate applies.
- Use the shared pickers/components rather than re-styling per feature; compact "IDE desktop" styling lives in shared classes (e.g. `picker-field`).
- Reference CSS design tokens from `styles/design-tokens.css`; don't hardcode colors.
