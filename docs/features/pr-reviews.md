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

For a bulk selection (up to ten PRs), two checkouts run concurrently while the
rest queue. The batch is named **Bulk PR Review — <local creation date>**.
Each PR reports its own live favourite, fetch, and worktree progress,
with a count of finished checkouts. Imports fetch into separate PR refs rather
than sharing `FETCH_HEAD`, so concurrent fetches cannot mix up commits.
Failures do not stop other PRs: all running/queued work finishes before retry is
enabled, successful reviews remain saved, and retrying in the same dialog
reuses the bulk parent. Tabs retain the selected PR order.

Each successfully imported PR, including a single-PR import, is automatically queued for Review Board
analysis immediately, without waiting for the rest of the imports or opening
its review tab. Up to three automatic PR reviews run concurrently across
batches. Each waits for its change graph before analyzing perspectives.
Switching or closing the tracker tab does not stop the shared queue, and
reopening it does not duplicate a queued, active or finished run. Failed
reviews require **Retry**; other imports/reviews continue.
The bulk tracker opens after the first successful import and adds PR rows as
their checkouts finish, even if another checkout fails. The import dialog
continues to show queued/importing/failed checkouts; the tracker shows each
imported PR's preparation phase, active perspectives and latest activity.

The bulk summary shows live **Batch elapsed** time and a final **Batch review
time**, measured as wall-clock time from the first review start to the last
finish—not the sum of parallel review durations. Every PR row and its Review
Board summary also show the latest full **Review time**, including evidence
preparation and analysis but excluding its queue wait. Timings remain with the
live run across tab navigation; retries measure a fresh attempt, and changed
evidence clears obsolete results and timings.
Each perspective also shows its own live/final analysis time. Its clock starts
when execution begins, not while it is queued, includes automatic retries and
freezes on success, skip or failure. Manually reanalyzing a section starts a new
section timer. Evidence preparation is measured separately. Parallel section
times are not added together as the full review's wall-clock duration.

The Review Board summary names the changed projects rather than only a generic
project type. Expand **Project details** for manifest paths, languages,
components, modules, runtime paths, deployment, base branch and commit.
Click the **files changed** count to browse captured changed-file diffs and
add inline comments. Unchanged boundary callers are excluded; binary files or
files without captured text remain visible with an explanation. Loading
failures offer a retry, and incomplete graph file coverage is stated explicitly.
Validated perspective results are persisted with the PR review's head and graph
revision and restored by the read-only board GET. Reopening a board never resets
the review or starts graph/AI work. Concurrent requests for the same perspective
share one analysis, and completed results are reused until an explicit reset.
Renderer timings survive tab navigation; recorded AIC remains independently
persisted. A failed graph retry does not delete earlier perspective results,
but cannot certify them for approval.

Approval uses `POST /features/:featureId/pr-review/approve` with
`{ expectedHeadSha, expectedReviewUpdatedAt? }`. Pass the board's `pull.headSha`
and `reviewUpdatedAt` to pin the confirmation to its displayed evidence.
`reviewUpdatedAt` uses the graph generation timestamp when available, not later
activity or usage updates. The backend requires completed, persisted analyses for
every perspective selected for that exact graph/head, checks the live provider
head, then sends the real provider approval.
`GET /features/:featureId/pr-review/approval-status` performs only a lightweight
provider-head read and eligibility check; it never fetches a worktree or
rebuilds the graph. Changed heads require an explicit reset and new review.
Concurrent approval clicks share one operation. Existing approvals are detected
at the provider; GitHub approval requests also name the reviewed `commit_id`.
Provider failures are reported rather than presented as successful approvals.
Older reviews without persisted machine results are not automatically certified.

Review Board summaries, perspective entries and bulk PR rows show live
vendor-reported **AIC**. These totals cover persisted review history, including
charged retries, rather than only the latest timed attempt. Missing billing is
shown as unavailable or partial, never estimated from tokens. Older operations
without a perspective identity contribute only to the board total.

The PR-review feature appears in the Explorer like any other feature. It shows a
**PR review panel** in its dashboard, and can be opened as a full **PR review
page** editor tab.

The read-only PR review response includes the imported `pull.sourceBranch` and
provider-reported `pull.author`. These survive explicit refreshes; authors are
null when unknown and can be absent on older records. No current-user identity
is substituted for missing author metadata.

## What the review contains

The AI review runs in the background and moves through *Analyzing → Ready* (or
*Failed*, with a Retry). When ready it shows:

- **PR Summary** — a problem statement and high-level overview.
- **Core Analysis** — a blind proposal, a **syntactic** review, a **business-logic**
  review, and a **0–100 score**.

## The change graph

The PR review page renders a **change graph**: a reference map of the functions
the PR modified and how they connect.

Graph analysis runs in an isolated background worker, not on the API thread.
The activity log shows queueing, changed-file reads and caller scanning. Worker
capacity, queue size, deadline and heap budget are bounded by `backgroundWork`
configuration (see [development](../development.md#non-blocking-background-work)).
A slow graph can fail with a Retry without blocking session lists, settings or
other requests. Refreshing or deleting the review cancels its old graph work.
Caller discovery bounds filesystem traversal to 50,000 directory entries and
source reads to 6,000 files. It caches project-directory lookups and skips
language parsing for files containing none of the changed type names. These
bounds do not raise the worker deadline; a timed-out analysis remains failed.

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

> **Supported languages.** The graph is built by deterministic static analysis
> (no AI, so it never hangs), one pluggable analyzer per language. Today it
> understands **C#** (`.cs`), **JavaScript/TypeScript** (`.js/.jsx/.ts/.tsx` and
> the `.mjs/.cjs/.mts/.cts` variants), **Java** (`.java`), **Rust** (`.rs`) and
> **C/C++** (`.c/.cc/.cpp/.cxx/.h/.hpp/…`). It also understands **Azure Service
> Fabric** application packaging (`ApplicationManifest.xml`, `ServiceManifest.xml`
> and `Settings.xml`): the application manifest is the composition root, so edges
> run from it to the service manifests it imports (`ServiceManifestName` /
> `ServiceTypeName`) and to the settings sections its `<ConfigOverride>`s target —
> a clean, uncluttered map of how the package is wired, grounded entirely in the
> manifest XML. Every graph feature — edges, caller
> blast-radius, the focused diagram, PR-description export — works for all of
> them out of the box; adding another language is a single analyzer, no builder
> or UI changes. To avoid false edges, a type name that appears only inside a
> comment, a string/template literal, an `import`/`using`/`use` line, or a
> `namespace`/`package` declaration never creates a reference.

> If a change graph shows empty diffs, it was generated before a diff-collection
> fix — click **Re-run all** (or a step's **Retry**) on the review page to
> re-collect and repopulate the per-file diffs.

## Review Board analysis validation

Review Board analysis requires a **Ready** change graph so its perspectives
and evidence reflect the collected change. If the graph is pending or generating,
wait for it to finish; if it failed, retry graph generation before analysis.

A perspective completes only after the model returns a usable JSON review
object. A clean review may return `findings: []`, but must include a nonblank
summary of what was reviewed. Findings require a title, detail, and usable
evidence; a skipped perspective requires an explicit nonblank reason.
Empty, malformed, prose-only, or unusable responses use the normal bounded
retry flow, including the final cold attempt. If validation still fails, the
perspective reports an actionable failure rather than an approved result.
Deterministic evidence detail only supplements an already validated review.

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

## Export to the PR description

The **Add to PR description** button writes the review's **problem statement** and a
Mermaid **change-graph diagram** into the pull request's description as a managed,
idempotent Markdown block (delimited by `ai-project-studio:pr-review` markers).
Re-running the export updates the block in place instead of appending a duplicate,
and any text you authored around it is preserved. Works for both GitHub and Azure
DevOps.

## Cleaning up worktrees

Each review checks its branch out into an isolated git **worktree** under a sibling
`.ai-worktrees` directory. These are removed automatically when you delete the
PR-review feature. To reclaim disk from orphaned checkouts, open **Settings →
Review worktrees**, which lists every app-managed worktree and lets you remove any
of them (a forced `git worktree remove` + `prune`).

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
