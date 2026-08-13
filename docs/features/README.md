# Feature guide

Task-focused guides for everything you can do in AI Project Studio. Each page
explains **what the feature is**, **where to find it in the app**, and **how to
use it step by step**.

| Guide | What it covers |
| --- | --- |
| [Feature categories](feature-categories.md) | How work is organized: Repository → Feature → Group → Session, and the default Scratchpad. |
| [Sessions](sessions.md) | Starting and running AI CLI sessions in the embedded terminal, summaries, and importing history. |
| [Skills](skills.md) | Reusable instruction blocks tagged onto features/sessions and auto-seeded into prompts. |
| [PR reviews](pr-reviews.md) | The "Open a PR" flow: review page, change graph, inline comments, and scoring. |
| [Monitors & Automations](automations.md) | Background monitors that run checks on an interval, evaluate conditions, and fire actions or tracked subagents. |
| [MCP servers](mcp-servers.md) | Managing Model Context Protocol servers and toggling their tools live. |
| [Usage & cost](usage-and-cost.md) | Live credit/token/cost meters, feature dashboards, and IDE AI attribution. |

## The app at a glance

The window has an **activity bar** on the far left with five destinations:

| Icon | View | Guide |
| --- | --- | --- |
| Files | **Explorer** (Workspace) | [Feature categories](feature-categories.md), [Sessions](sessions.md) |
| Skills | **Skills** | [Skills](skills.md) |
| Automations | **Automations** | [Monitors & Automations](automations.md) |
| MCP | **MCP Servers** | [MCP servers](mcp-servers.md) |
| Settings | **Settings** | see [development.md](../development.md) |

The bottom **status bar** always shows the active view, active session count, and
live **IDE AI**, **AIC**, and token totals. A theme toggle (sun/moon) sits at the
bottom of the activity bar.

For the technical UI reference (what components are mounted where) see
[../ui-guide.md](../ui-guide.md). For how the pieces fit together see
[../architecture.md](../architecture.md).
