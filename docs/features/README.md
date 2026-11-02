# Feature guide

Task-focused guides for everything you can do in AI Project Studio. Each page
explains **what the feature is**, **where to find it in the app**, and **how to
use it step by step**.

**Provider readiness:** interactive support does not imply support for every
agent, AI planner or headless surface. Agency is currently **interactive-only
for IDE-launched AI automation** because native MCP overlays cannot be safely
isolated. For metasessions choose Copilot, or Claude with a safe/nonmanaged
profile and supported API/cloud credentials; readiness/policy checks still
apply. Plain task organization and non-AI checks do not themselves need an AI
turn. See [provider safety](../adding-a-provider.md#headless-tool-isolation).

| Guide | What it covers |
| --- | --- |
| [Feature categories](feature-categories.md) | How work is organized: Repository → Feature → Group → Session. |
| [Planner](planner.md) | Dated tasks/backlog, remote imports, exports, AI summaries, and recoverable workspace launches. |
| [Sessions](sessions.md) | Starting and running AI CLI sessions in the embedded terminal, summaries, and importing history. |
| [Skills](skills.md) | Reusable instruction blocks tagged onto features/sessions and auto-seeded into prompts. |
| [PR reviews](pr-reviews.md) | Open Pull Request: Review Board summary, change graph, perspectives, comments and approval. |
| [New Task](new-task.md) | Attach the New Task agent: plan a change, implement it with a parallel agent team, and open a PR. |
| [Bug Bash](bug-bash.md) | Attach the Bug Bash agent: generate edge-case test scenarios, run them across a parallel tester team, and report what breaks. |
| [Monitors & Automations](automations.md) | Background monitors that run checks on an interval, evaluate conditions, and fire actions or tracked subagents. |
| [MCP servers](mcp-servers.md) | Source-scoped configuration, read-only provenance, and supported tool inspection. |
| [Usage & cost](usage-and-cost.md) | Live credit/token/cost meters, feature dashboards, and IDE AI attribution. |

## The app at a glance

The window has an **activity bar** on the far left with these destinations:

| Icon | View | Guide |
| --- | --- | --- |
| Files | **Explorer** (Workspace) | [Feature categories](feature-categories.md), [Sessions](sessions.md) |
| Planner | **Planner** | [Planner](planner.md) |
| Skills | **Skills** | [Skills](skills.md) |
| MCP | **MCP Servers** | [MCP servers](mcp-servers.md) |
| Monitors | **Monitors** (Automations) | [Monitors & Automations](automations.md) |
| Usage | **Usage** | [Usage & cost](usage-and-cost.md) |
| Agents | **Agents** | [../agents.md](../agents.md), [New Task](new-task.md) |
| Settings | **Settings** | see [development.md](../development.md) |

The **Agents** view is a catalog of every installed agent (Review Board, New
Task, Bug Bash) with its prompts, settings, and average credits per run.
There are **eight** top-level views. **Repository Insights** is discoverable in
repository workspace/dashboard surfaces; **Shared Context** panels live in
repository/feature surfaces alongside reusable [skills](skills.md#shared-context).
Neither is a ninth activity-bar destination.

The bottom **status bar** always shows the active view, active session count, and
live **IDE AI**, **AIC**, and token totals. A theme toggle (sun/moon) sits at the
bottom of the activity bar.

For the technical UI reference (what components are mounted where) see
[../ui-guide.md](../ui-guide.md). For how the pieces fit together see
[../architecture.md](../architecture.md).
