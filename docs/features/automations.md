# Monitors & Automations — background checks and actions

**Monitors & Automations** lets AI Project Studio run background work from the
app. A monitor periodically runs a **check**, evaluates the result against a
**condition**, and fires an **action** when the condition matches.

## Where to find it

Open **Automations** from the activity bar. The page is split into categorized
lists:

- **Monitors**, grouped by mode and status.
- **Subagents**, the tracked background AI tasks spawned by automations or
  registered through the MCP bridge.

Each card shows the name, mode badge, status, origin, progress, planned next
steps, last check result/time, next-run countdown, and run count. Open a card to
see run history and the planned-steps timeline.

## Create an automation

There are two creation paths:

1. **From an in-session AI turn.** The app exposes a local MCP server to the
   session. The AI can register and update automation work through tools such as
   `create_monitor`, `set_planned_steps`, `update_monitor_progress`,
   `register_subagent`, `update_subagent_progress`, and `list_automations`.
2. **From the Automations page.** Enter a prompt describing what should be
   watched and what should happen. The page starts a metasession that sets up
   and runs the automation.

Automations are workspace-global, but each record keeps the originating
session/feature when one exists.

## Monitor modes

- **Short** — fires once when its condition matches, then completes.
- **Long** — keeps polling until cancelled or an optional `maxRuns` cap is
  reached. Long monitors are edge-triggered: they fire only on the transition
  into the matching state, not on every tick while the state remains matching.

## Checks, conditions, and actions

Checks collect the current state:

- `shell` — run a command and read its exit code/output.
- `http` — poll a URL and read the response status/body.
- `ai` — ask the AI a yes/no question through a metasession.
- `ci-pipeline` — poll a GitHub Actions run. Azure returns `null`/unsupported
  for now.

Conditions decide whether the state matches:

- `always`
- `exit-code` — equals a configured numeric exit code.
- `status-equals`
- `conclusion-equals`
- `text-contains`
- `ai-verdict`

Actions run when the condition matches:

- `metasession` — run a headless AI turn.
- `subagent` — spawn a tracked background AI task with an assigned task and
  progress.
- `report` — run a metasession and keep its output on the run record.
- `command` — run a shell command.

## Authentication handling

Checks often hit resources that require sign-in — for example an Azure DevOps
release URL that redirects to a Microsoft sign-in page, or a `gh`/`az` CLI that
is not logged in. Monitors run with the app's full environment, so they **reuse
the logins already present on your machine** — a prior `az login` /
`gh auth login`, or an IDE-provided token. In most cases no extra sign-in is
needed.

If a check still can't authenticate (an HTTP `401`/`403`, a sign-in/OAuth
redirect, or messages such as "please run az login" / "not logged in"), the
monitor is **not** left to fail silently on every tick. It is parked in the
**Sign-in required** (`needs-auth`) state: scheduling stops and the card shows a
prompt.

To recover:

- If you are already signed in on this machine (in the IDE, or via
  `az login` / `gh auth login`), just click **Resume** — the monitor reuses
  that login.
- Otherwise sign in once in a terminal, then **Resume**.

> Tip: `ci-pipeline` with `provider: "azure"` expects an Azure Pipelines repo,
> not a classic release URL. To watch an Azure DevOps release, use an `http`
> check against the release REST API (with a `text-contains`/`ai-verdict`
> condition) or a `shell` check running the `az` CLI.

## Subagents

A **subagent** is a tracked background AI task. It has a task, status
(`queued`, `running`, `done`, or `failed`), progress, and result. Subagents can be
spawned by an automation action or registered by the in-session AI through the
local MCP bridge.

## Manage automations

From the Automations page:

1. Find the monitor or subagent card in its category.
2. Use **Pause** to stop scheduling without deleting the record.
3. Use **Resume** to continue a paused or sign-in-required monitor.
4. Use **Run now** to trigger an immediate check/action cycle.
5. Use **Cancel** to stop a running or scheduled automation.
6. Use **Delete** to remove the automation.
7. Open the detail view to inspect run history, report output, and the
   planned-steps timeline.

## Persistence and resume

Automations are stored in the attached SQLite database `automations.db`, using
the `automations`, `automation_runs`, and `subagents` tables. The scheduler
resumes persisted automations across app restarts.

## Cost attribution

Check, action, and subagent AI runs go through the shared meta runner, so their
usage folds into the existing cost accounting. Usage is attributed to the origin
feature when one is present; otherwise it uses a stable `automation:<id>` key and
is credited under **IDE AI**. See [Usage & cost](usage-and-cost.md).

## API and MCP bridge

The REST API under `/api` exposes:

- `GET /automations`
- `GET /automations/:id`
- `POST /automations`
- `POST /automations/:id/pause`
- `POST /automations/:id/resume`
- `POST /automations/:id/cancel`
- `POST /automations/:id/run`
- `DELETE /automations/:id`

The local MCP server exposes automation tools to in-session AI:

- `create_monitor`
- `update_monitor_progress`
- `set_planned_steps`
- `register_subagent`
- `update_subagent_progress`
- `list_automations`

Live updates are streamed to the UI as `automation.updated`,
`automation.removed`, and `subagent.updated` events.

## Related

- [Sessions](sessions.md) — in-session AI can create monitors through the MCP
  bridge.
- [MCP servers](mcp-servers.md) — how MCP tools are managed in the app.
- [Usage & cost](usage-and-cost.md) — how automation AI usage is attributed.
- [Architecture](../architecture.md#monitors--automations) — scheduler,
  persistence, and data-flow internals.
