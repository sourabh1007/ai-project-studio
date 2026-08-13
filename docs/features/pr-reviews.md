# PR reviews — review a pull request

AI Project Studio can turn a pull request into a dedicated, AI-assisted review
workspace: a review page with an AI analysis, a navigable **change graph** of the
modified functions, per-file **code diffs**, and inline **PR comments** that sync
back to the PR.

## Where to find it

From a **repository** row in the Explorer, choose **Open a PR**. This:

1. Lists the repository's open pull requests (search by number, title, branch, or
   author) — or accepts a PR number/URL directly.
2. Checks the branch out into a git **worktree** and creates a **PR-review
   feature** for it. You can open multiple PRs at once.

The PR-review feature appears in the Explorer like any other feature. It shows a
**PR review panel** in its dashboard, and can be opened as a full **PR review
page** editor tab.

## What the review contains

The AI review runs in the background and moves through *Analyzing → Ready* (or
*Failed*, with a Retry). When ready it shows:

- **PR Summary** — a problem statement and high-level overview.
- **Core Analysis** — a blind proposal, a **syntactic** review, a **business-logic**
  review, and a **0–100 score**.

## The change graph

The PR review page renders a **change graph**: a reference map of the functions
the PR modified and how they connect.

- **Navigate:** zoom, pan, and — for large graphs — scroll inside the box, or
  open it **full screen**.
- **Show/hide callers:** a toggle adds or removes the surrounding call sites so
  you can focus on just the changes or see their blast radius.
- **Select a node** to open a detail popup with that file's **code diff** and its
  inline **PR comments**.
- **Jump between files without closing the popup:** the popup's **focused node
  diagram** is clickable — clicking a connected file replaces the popup with that
  file's popup, so you can walk the call graph file by file.

> Reference edges are clipped to each box's border, so an arrow starts at the
> edge of one module/file and ends at the edge of the next instead of crossing
> over the box labels.

> **Arrow labels read in the arrow's direction:** `caller() → Symbol` means the
> function `caller` in the source file calls or uses the class `Symbol` declared
> in the target file; `init Symbol` marks a module/field/base-type reference
> (`Symbol` is being initialised rather than called from inside a function).
> Dense edges are deduped and capped as `first +N` so they stay legible.

> **Tests stay in the test graph.** Files under test-project folders — including
> .NET conventions like `Foo.Tests/`, `Foo.Test.Unit/`, or `FooUnitTests/` — are
> classified as tests, so the **Code changes** graph shows only production changes
> and the spurious test↔code edges are gone. Switch to the test category to review
> the test changes on demand.

> If a change graph shows empty diffs, it was generated before a diff-collection
> fix — click **Re-run all** (or a step's **Retry**) on the review page to
> re-collect and repopulate the per-file diffs.

## Live PR comments

While reviewing, you can **read and post review comments** against the exact
file/line. Comments render with **Markdown/GFM** support and sync back to the pull
request on **GitHub** and **Azure DevOps**.

**Comment in place:** in a file popup's code diff, **click any line** (added or
context) to open an inline composer and post a comment anchored to that line — no
line-number dropdown. Existing threads render inline beneath their line (a 💬
marker flags commented lines); threads whose line falls outside the bounded diff
are listed above it.

## Approve the PR

Use the **Approve** button in the review page header to cast your approval without
leaving AI Project Studio. The action uses the signed-in reviewer account and works
for both **GitHub** and **Azure DevOps** pull requests.

If you have **already approved** the pull request, the button recognizes your existing
vote and shows **Already approved** instead of casting a duplicate approval. On Azure
DevOps the approval is cast against your organization identity, so it works even when
your profile and organization ids differ.

## Re-running

The review page exposes **Re-run all** and per-step **Retry** controls, so you can
regenerate the whole review or just the step you need after code changes.

## Cost attribution

PR-review generation runs as an internal **meta session**, so its credits/tokens
are itemized and attributed to **IDE AI** rather than your feature development
cost. See [Usage & cost](usage-and-cost.md).

## Related

- [Feature categories](feature-categories.md) — PR reviews are a kind of feature.
- [Usage & cost](usage-and-cost.md) — how review cost is attributed.
- [Architecture](../architecture.md#pr-review) — diff collection, prompt, and
  persistence internals.
