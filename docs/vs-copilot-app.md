# AI Project Studio vs. the GitHub Copilot app

The GitHub Copilot app/CLI is a single-conversation coding assistant. **AI Project
Studio does not replace it** — it wraps that same CLI in a project-centric,
observable workspace. The Copilot app is the *engine*; AI Project Studio is the
*cockpit* that organizes and instruments it.

## Side by side

| Area | Copilot app / CLI | AI Project Studio |
| --- | --- | --- |
| **Primary unit of work** | A single chat/session | **Feature → Group → Session** hierarchy grouping many runs |
| **Interface** | Terminal or editor chat pane | **IDE-style desktop app** (Electron) with an embedded `xterm.js` terminal |
| **Usage & cost visibility** | Per-response, ephemeral | **Live credit (AIC), token, cost & time** streamed over SSE and persisted per session/feature |
| **Analytics dashboards** | None | **Feature dashboard**: AIC-over-time, AIC-by-model, time-by-session charts + KPI cards |
| **Reusable instructions** | Manual copy/paste each session | **Skills** — instruction blocks tagged to features/sessions and auto-seeded into a session's first prompt |
| **Task planning** | Ad hoc, in-conversation | **Planner** dated tasks/backlog, imports/exports, summaries and workspace launches; separate feature task plans |
| **Summaries** | None persisted | **Automatic per-session and feature-level summaries** |
| **PR review** | Manual prompting | **Review Board**: summary/change graph, evidence-grounded perspectives, file diffs, comments, reviewer sign-off and provider-backed approval |
| **Feature agents** | Provider-specific automation | **New Task** plans/implements a change; **Bug Bash** prepares scenarios, runs testers and audits evidence |
| **Monitors** | CLI-specific background tools | Workspace-global checks/actions, tracked subagents, progress and provider-aware sign-in recovery |
| **MCP servers** | Configured via CLI/config files | Source/provenance-aware configuration and supported independent **tool inventory probes**; not generic live restarts/toggles |
| **Metasession attribution** | N/A | Internal AI steps run as **metasessions** with **itemized, clearly-labeled** credit/token usage (the **IDE AI** figure) |
| **History** | Provider-native store only | Provider-keyed history and capability-based import, including Agency and Claude |
| **Provider support** | GitHub Copilot only | Copilot, authorized optional Agency and native **Claude Code v2**; Claude headless runs need operator-owned API/cloud credentials |
| **Persistence** | CLI's own session store | **Local-first SQLite** (`node:sqlite`): features, sessions, usage, transcripts, summaries |
| **Configuration** | CLI flags / config file | **Namespaced, editable config** surfaced in a Settings UI |

These are this app's intended capabilities, not an exhaustive statement that
every upstream Copilot client lacks equivalent features. Billing/quota can be
unavailable; separately labelled USD estimates do not substitute for native AIC.

## When to use which

- Reach for the **Copilot CLI directly** for a quick, one-off question where you
  don't care about organizing or measuring the work.
- Use **AI Project Studio** when you want to group related runs under a feature,
  see and compare their cost, reuse instructions via skills, review pull requests,
  or work across more than one CLI provider.

## Learn more

- [Feature guide](features/README.md) — every feature, with navigation and how-to.
- [Architecture](architecture.md) — how the app wraps and instruments the CLIs.
