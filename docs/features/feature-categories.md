# Feature categories — how work is organized

AI Project Studio organizes every AI CLI run into a clear hierarchy so related
work stays together and its cost is easy to measure.

```
Repository            (an optional git checkout the work targets)
└─ Feature           (can contain nested sub-features)
   ├─ Subcategory    (optional session grouping)
   │  └─ Session    (one interactive CLI run)
   └─ Agent tab      (Review Board, New Task, or Bug Bash)
```

You do **not** have to use every level. The only required unit is a **Feature**;
everything else is optional structure you add when it helps.

## Where to find it

Open the **Explorer** (the Files icon at the top of the activity bar). The
Explorer is the tree on the left of the Workspace view. Drag its right edge to
resize it, or click the Explorer icon again to collapse/expand it.

## The building blocks

### Repository (optional)
A saved git checkout that features can target. When you add one, the app analyzes
it in the background to build a **repository context** that is fed to every
session started under it.

- **Add:** click **Add repository** in the Explorer header and point it at a
  local checkout (or provision one from a provider).
- Each repository row shows a **context badge** — *Pending → Analyzing → Ready*
  (or *Refreshing* / *Failed*). Context generation is nonblocking: a summary
  still being prepared or failing does not by itself disable new sessions.
  Click the badge (or **View context**) for its summary, progress and errors.
- Open the repository dashboard for **Repository Insights** (repository-wide
  analysis) and its **Shared Context** surface. These are repository/workspace
  panels, not additional activity-bar destinations.

### Feature — the primary category
A **Feature** is the main organizing unit: a task, ticket, or area of work. It
can be attached to a repository or be repo-less.

- **Create:** click **New feature** (the `+` on a repository row to attach it, or
  the top-level `+` for a repo-less feature). Give it a name and optional
  description.
- **Rename / delete:** use the feature's overflow (`⋯`) menu.
- Opening a feature shows its **dashboard** — charts, task plan, and summaries.
  See [Usage & cost](usage-and-cost.md).
- Features can contain **nested sub-features**. Attach available agents from
  the feature's agent controls; their work opens in dedicated workspace tabs.
  Availability depends on prerequisites such as a linked repository or PR.

### Subcategory (optional)
A **subcategory** groups sessions within a feature; it is distinct from a nested
feature and from an agent attachment.

- **Create:** use **New subcategory** on a feature. Use **Open Pull Request**
  from a repository to import PR-review features, not to create a subcategory.

### Session
A **Session** is a single interactive CLI run under a feature (or group). This is
where you actually chat with the AI in the embedded terminal — see
[Sessions](sessions.md).

## Two ways to start from a repository

From a repository row you can either:

1. **New feature** — start fresh work against the repo, or
2. **Open a PR** — review an existing pull request. This checks the branch out
   into a worktree and creates a PR-review feature. See [PR reviews](pr-reviews.md).

## Reorganizing

Sessions and groups can be **dragged** to a different feature in the Explorer;
both the source and destination refresh so the move is reflected immediately.

## Related

- [Sessions](sessions.md) — run work inside a feature.
- [Usage & cost](usage-and-cost.md) — how cost rolls up Feature → Group → Session.
- [Architecture](../architecture.md) — session readiness and bootstrap internals.
