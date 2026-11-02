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

## Related

- [Feature categories](feature-categories.md) — where launched work lives.
- [Sessions](sessions.md), [New Task](new-task.md), [PR reviews](pr-reviews.md).
- [Usage & cost](usage-and-cost.md) — summaries and launch-related AI usage.
