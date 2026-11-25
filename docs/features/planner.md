# Planner — organize and launch work

Open **Planner** in the activity bar. It is a dated task list, separate from a
feature's generated implementation plan.

Task organization/import/export is distinct from AI execution. **AI summaries
and AI-backed launches need a metasession-capable provider**: Copilot, or Claude
with safe/nonmanaged configuration and supported API/cloud credentials.
Agency's interactive availability does not enable these automated turns.

## Plan your day

- Choose a date, add a title and optional notes, and update a task's status.
- Move unfinished work to another day, or defer it to **Backlog** and restore
  it to a chosen date later. Quick-add drafts survive view switches.
- **Import tasks** supports Azure DevOps work items/PRs and GitHub issues/PRs.
  Choose the repository/source and apply its filters explicitly. **Search
  loaded …** and **Team** refine the returned list locally, not the entire
  remote repository; the dialog reports loaded/shown counts and possible caps.
- Export the selected day's tasks as **Markdown**, **JSON**, or **CSV**.
- Generate an AI **Day / Month / Year** summary with an optional prompt, and
  download it as Markdown or HTML. Summaries use the active CLI's headless
  credentials and count toward IDE AI usage; they are not free local analysis.

## Launch work

A task offers relevant actions: **Session**, **New Task**, or **Review Board**
(when a PR can be resolved). Confirm the target repository when asked. Launch
creates/links the workspace destination, then opens it; follow-up opens should
reuse that link rather than create duplicate features, tasks, or sessions.

Launch progress and failures are shown on the task. If the result is uncertain
after a connection loss, use the offered recovery/retry action: it reconciles
the retained operation rather than assuming creation failed. Do not repeatedly
create a replacement task while the original outcome is unknown. A missing or
deleted destination is reported instead of silently opening unrelated work.
View changes do not mean background work was cancelled.

## Automatic work tracking

Tracking is on by default for recent user work. It runs in the background,
independently of the Planner view, rather than waiting for an end-of-day digest.
Every 15 seconds it advances a bounded queue of eligible workspaces. New sessions
and recorded session activity prioritize their workspace. AI latency and queued
work can delay a refresh; this is not a guaranteed 15-second completion deadline.

The tracker analyzes bounded recent prompts and completed responses, correlated
agent operations, associated or explicitly mentioned PR URLs, and recorded skill
events. It separates independent deliverables and semantically matches existing
work before creating tasks. Stable persisted keys and source fingerprints prevent
ordinary replay/restart duplicates. Full PR URLs, not just numbers, distinguish
different repositories. Matching is AI-assisted, not a guarantee of perfect
semantic deduplication.

An **AI icon** beside a tracked task opens its evidence. Prompt requests,
assistant-reported results, agent state/perspective, PR mentions, and repository,
IDE or CLI skill activity remain distinguishable. Prepared/injected skills are
not described as invoked. Missing native skill telemetry is not inferred.
Completion is **reported**, not independent proof that tests passed or a PR was
pushed. Streaming response chunks do not each trigger a new extraction.

Generated titles, notes, and status update while unchanged by the user. Once an
edit is observed, that field remains protected; dates, priority, backlog, and
launch links are not rewritten. Existing manually authored tasks are matched
conservatively without replacing their content. Deleting a tracked task retains
its work-key tombstone, preventing that same work key from recreating it.

Open the compact **Auto tracking** disclosure to pause/resume, inspect queue or
refresh errors, and see the cost/privacy explanation. Pausing persists across
restart and cancels in-flight tracking. It does not erase existing tasks.
Tracking uses the configured background AI provider/model and its credentials,
permissions, and credit accounting; source excerpts are sent to that provider
and evidence is stored locally with Planner data. It never grants the extraction
turn tools. Provider failures or malformed output leave existing tasks unchanged
and retry with backoff.

`planner-tracking` configuration owns the initial enabled default, poll/retry
intervals, timeout, and discovery lookback (24 hours by default, up to 7 days).
Each snapshot reads at most four sessions/four recent turns per session, four
agent operations and twelve skill events, with a 48,000-character evidence text
budget. Matching considers up to 50 recent task candidates and 100 tracked-work
identities in the same repository (same feature for repo-less work). A response
can create/update at most eight tasks; each task retains at most twenty evidence
items. Limits/excerpts mean this is incremental assistance, not an exhaustive
historical audit. Background/internal sessions are excluded to avoid tracking the
tracker's own analysis. Copilot/Agency use bounded native turn projections plus
worker-read live events; Claude uses its worker-populated bounded native cache.

## Related

- [Feature categories](feature-categories.md) — where launched work lives.
- [Sessions](sessions.md), [New Task](new-task.md), [PR reviews](pr-reviews.md).
- [Usage & cost](usage-and-cost.md) — summaries and launch-related AI usage.
