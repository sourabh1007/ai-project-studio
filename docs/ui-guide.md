# UI guide

The UI is a React + Vite SPA in `ui/`. It talks to the backend over HTTP (REST), Server-Sent Events (live usage/session updates), and a WebSocket (interactive terminal).

## What's actually mounted

`ui/src/App.tsx` renders four top-level views (selected from the activity bar):

- **Workspace** (`features/workspace/`) — the IDE shell: explorer sidebar, session tabs, embedded terminal, new-session form, import-session panel, feature dashboard tabs.
- **Skills** (`features/skills/`) — manage/tag reusable instruction skills.
- **MCP Servers** (`features/mcp/`) — manage Model Context Protocol servers and their tools per provider.
- **Settings** (`features/settings/`) — app configuration.

> **Not mounted (legacy/dead):** `features/feature-board/`, `features/feature-detail`, and `features/session-panel/` are not reachable from `App.tsx`. Treat them as historical; don't rely on them for current behavior.

## Feature areas (`ui/src/features`)

| Area | Purpose | Mounted? |
| --- | --- | --- |
| `workspace/` | IDE shell: `workspace-view.tsx`, `explorer.tsx`, repository-context status/viewer, `new-session-form.tsx`, `import-session-panel.tsx`. | ✅ |
| `feature-dashboard/` | Feature analytics: charts, `feature-tasks-panel.tsx`, `pr-review-panel.tsx`, `work-summary.tsx`. | ✅ (within workspace) |
| `skills/` | `skills-manager.tsx`, `skill-tagger.tsx`, `skill-chips.tsx`, `skill-kind.tsx`. | ✅ |
| `mcp/` | `mcp-manager.tsx`, `mcp-server-form.tsx` — add/edit/restart MCP servers, discover and toggle tools. | ✅ |
| `pr-review-page/` | `pr-review-page.tsx`, `change-graph.tsx`, `pr-comments.tsx` — dedicated PR review page opened as an editor tab. | ✅ (within workspace) |
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

## Repository context UX

Each saved repository row in the Explorer shows a live context badge:

| Backend status | UI label | Behavior |
| --- | --- | --- |
| `pending` | Pending | Spinner; new repository-backed sessions are disabled. |
| `generating` | Analyzing | Spinner; sessions remain disabled. |
| `ready` | Ready | Sessions are enabled. |
| `stale` | Refreshing | Spinner; the checkout changed and sessions remain disabled until regeneration succeeds. |
| `failed` | Failed | Failure text is shown; sessions remain disabled and the viewer offers **Retry**. |

Click the badge, or choose **View context** from repository actions, to open `workspace/repository-context.tsx`. The viewer shows source revision, generated/updated timestamps, lifecycle state, failure details, and the generated summary. While analysis is in flight it shows an animated "Analyzing repository" banner (`role="status"`) plus a step checklist (`collect-evidence` → `analyze` → `persist`) that marks each step running/ok/failed/skipped in real time, so it is clear what the app is doing and exactly which step failed. If a later attempt fails, the last successful summary remains visible with an explicit warning. **Refresh** starts a background generation request; while the request is being accepted the button is disabled and inline API errors are shown. A failed state changes the action label to **Retry**.

The Explorer initially fetches `GET /repos/:id/context` for every repository. It then consumes `repository.context.updated` from the shared SSE stream and keeps the newest record by `updatedAt`, so pending/analyzing/stale/ready/failed transitions appear without polling. Adding a repository triggers generation on the backend; manual refresh uses `POST /repos/:id/context/refresh`.

For a feature attached to a repository, the new-session `+` button is disabled unless context is `ready`. A status message explains whether analysis is pending, running, refreshing after a checkout change, or failed. If readiness changes while the new-session form is open, the form closes. The backend repeats this readiness check, so stale UI state cannot launch an unbootstrapped development session. Features without a repository are not gated; importing past sessions is also unaffected.

When a development session launches, the UI does not assemble context itself. The backend supplies a fresh bootstrap containing repository context, feature details, prior completed development-session summaries, and effective skills. Repository-analysis runs are hidden from Explorer/session SSE, while their usage appears in the existing **IDE AI** accounting view.

## PR review UX

A feature created from a pull request renders a **PR review panel** (`feature-dashboard/pr-review-panel.tsx`) inside its dashboard. On mount it fetches `GET /features/:id/pr-review`; a `404` means the feature is not a PR review and the panel renders nothing. While generation is in flight it shows an animated "Analyzing pull request…" banner (reusing the repository-context spinner/dots). When ready it shows the **PR Summary** and **Core Analysis** sections; on failure it shows the failure detail and a **Retry** control. The panel consumes `pr.review.updated` from the shared SSE stream and prefers live state over the initial fetch, so lifecycle transitions appear without polling. **Refresh** calls `POST /features/:id/pr-review/refresh` to regenerate the review; the previous summary is retained for viewing if a later attempt fails.

Opening a PR review as its own editor tab renders the full **PR review page** (`pr-review-page/pr-review-page.tsx`), which adds the per-file **change graph** (`change-graph.tsx`). The graph is a static reference graph of PR-modified functions and their connections; it supports **zoom, pan, internal scroll for large graphs, and full-screen**, plus a **show/hide callers** toggle. Selecting a node opens a detail popup with that file's **code diff** and inline **PR comments** (`pr-comments.tsx`). The page exposes **Re-run all** and per-step **Retry** controls; re-running re-collects diffs, so reviews generated before a diff-collection fix repopulate their per-file diffs.

## MCP server management UX

The **MCP Servers** view (`features/mcp/mcp-manager.tsx`) manages Model Context Protocol servers per provider. It lists the MCP-capable providers, and for the selected provider shows each configured server as a card with its spec summary and tool-discovery status. From here you can **add** and **edit** servers (`mcp-server-form.tsx`), **restart** a server, and **enable/disable individual tools** surfaced by a live discovery probe. Tool toggles and restarts take effect for already-open sessions without restarting the shell. Authentication, when required, is handled as part of the restart/discovery flow.

## Conventions

- Keep testable logic in `lib/` (parsing, formatting, stream state) — that's where the UI coverage gate applies.
- Use the shared pickers/components rather than re-styling per feature; compact "IDE desktop" styling lives in shared classes (e.g. `picker-field`).
- Reference CSS design tokens from `styles/design-tokens.css`; don't hardcode colors.
