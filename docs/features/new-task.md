# New Task

**New Task** is an agent you attach to a feature to solve a problem in its
repository end to end: it **plans** the change for you to review, then — on your
approval — **implements** it with a team of parallel agents, opens a **pull
request**, and hands the result to the [Review Board](pr-reviews.md).

> New Task is an [agent](../agents.md). Attach it from a feature that has a
> linked repository; several can run on one feature, each solving a distinct
> problem.

## The flow

```
Describe ─▶ Plan ─▶ Review ─▶ Implement ─▶ Summary
 problem    (AI)    read it    (AI team)    PR + diffs
 + context                     in parallel
```

1. **Describe** — write the problem and any context.
2. **Plan** — a planner metasession reads the repo and produces a concrete,
   reviewable implementation plan. Live logs stream as it works.
3. **Review** — read the plan. Approve it, or re-plan with a suggestion (a
   re-plan discards the old branch and cuts a fresh one).
4. **Implement** — a **lead agent** decomposes the plan into file-disjoint
   slices and dispatches specialized **sub-agents** (developer / tester) that
   each lease their own metasession and work **in parallel**. The lead agent
   reviews the combined result and builds only the affected projects.
5. **Summary** — the PR (title + a **Problem / Solution** description), the list
   of changed files, planning/implementation time, and AI credits.

## The agent team

The Implement step shows the hierarchy live:

- **Agents & sub-agents panel** — the lead agent with its sub-agents nested
  underneath, each tagged by role, with **live time, tokens, and AI credits**.
- Click any agent to open its **live log** (the exact prompt it was given, then
  its streamed reasoning and tool activity).
- Click any **changed file** (on an agent card or in the summary) to open its
  **diff**, with a toggle to view the full file on the branch.

Running several sub-agents on their own metasessions — drawing on the
[warm pool](../metasessions.md#runner-chain-composed-in-maints) — is what makes
a large change land quickly instead of one file at a time.

## Cancel & reset

An in-flight run can be **cancelled** from the page: it aborts the background
metasessions (terminating any attached process) and resets the task to a clean
draft. Switching windows does **not** stop planning or implementation — they run
in the background and the page reconnects to the live logs when you return.

## Where the work lives

Each run is isolated in its own git **worktree** and branch, so it never
disturbs your checkout. The worktree persists after the PR is opened, which is
how the file diffs stay viewable. See
[backend-modules.md](../backend-modules.md) (`new-task/`) and
[metasessions.md](../metasessions.md) for the internals.
