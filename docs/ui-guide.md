# UI guide

The UI is a React + Vite SPA in `ui/`. It talks to the backend over HTTP (REST), Server-Sent Events (live usage/session updates), and a WebSocket (interactive terminal).

> This is the **technical** UI reference (what components are mounted where). For
> user-facing how-tos of each view, see the [feature guides](features/README.md).

## Desktop startup

Development UI rebuilds preserve previous hashed assets so open windows can
still load their lazy panels. If an interface asset is unavailable, the error
boundary offers **Reload app** instead of repeating a cached failed import.
Reload is explicit, not automatic, to protect unsent input.

The Electron shell shows a branded startup window before starting local services.
It uses the 1024px app icon, animated loading indicators, persisted light/dark
appearance, and reduced-motion preferences. The displayed milestones follow
actual startup: desktop settings, local backend readiness, and interface loading;
there is no simulated percentage or artificial delay.

The main window stays hidden until its page loads successfully and paints.
Startup errors remain visible with an explanation and a close control. Closing
the startup window uses the same cooperative backend shutdown as the main app.
Missing Node.js or an early backend exit is reported immediately rather than
waiting for the readiness timeout. Startup failures write a bounded
`desktop-startup.log` in the desktop user-data directory; the error shows its
location. Each failed launch replaces that diagnostic file.

If no backend process could be started, the desktop closes normally. If the
backend has already exited without confirming cleanup, **Close app** is available
in a warning dialog. This closes only the desktop; it does not claim cleanup
succeeded, restart the backend, or launch an installer. **Keep open** preserves
the error screen without an ongoing closing animation. A still-running backend
continues to require cooperative cleanup.

Development launches connect to the existing server rather than spawning a second
backend. Assets and the isolated preload live in `desktop/startup/`; lifecycle
coordination is in `desktop/startup-splash.cjs` and `desktop/main.cjs`.

## What's actually mounted

`ui/src/App.tsx` renders five top-level views (selected from the activity bar):

- **Workspace** (`features/workspace/`) — the IDE shell: explorer sidebar, session tabs, embedded terminal, new-session form, import-session panel, feature dashboard tabs.
- **Skills** (`features/skills/`) — manage/tag reusable instruction skills.
- **Automations** (`features/automations/`) — monitor and manage background monitors and tracked subagents.
- **MCP Servers** (`features/mcp/`) — manage Model Context Protocol servers and their tools per provider.
- **Settings** (`features/settings/`) — app configuration.

> **Not mounted (legacy/dead):** `features/feature-board/`, `features/feature-detail`, and `features/session-panel/` are not reachable from `App.tsx`. Treat them as historical; don't rely on them for current behavior.

## Feature areas (`ui/src/features`)

### Session checkout and startup

New non-PR sessions use the repository's existing checkout on `master`.
PR sessions reuse the feature's existing PR checkout. Opening a session does
not clone, fetch, add a worktree, generate a session branch or detach HEAD.
Multiple sessions share the same working directory: branch changes, commits
and edits are visible to all of them. Branch selection is serialized per
checkout to avoid concurrent index locks. Git refuses a switch that would
overwrite local edits; the app never forces, resets or stashes them.

Reconnecting to a running terminal does not switch branches. Previously
started shared sessions retain the checkout's current branch when reopened.
Existing recorded per-session copies are preserved, not deleted or migrated.
The Worktrees manager continues to expose legacy copies for cleanup.

In **Settings → Worktrees**, removals run independently (up to three at once),
with queued, deleting and retryable error feedback on each row. Other rows and
the rest of the app stay usable while Git and filesystem cleanup run
asynchronously. Refresh preserves pending rows and does not resurrect completed
removals from an older response. The backend also bounds and deduplicates
removals, refuses busy or primary checkouts, and never bypasses a linked
worktree's Git removal failure by forcibly deleting its files.

Startup shows real checkout progress, a spinner and elapsed time.
Reconnecting views join the same preparation job rather than duplicating it.
Disconnecting a view stops its terminal launch wait but lets shared preparation
finish. Failures display the actual reason and offer **Reconnect**, without
replaying input or substituting a different branch.

`sessionWorktree.gitTimeoutMs` defaults to 20,000 ms for metadata commands;
`checkoutTimeoutMs` is 600,000 ms for switching branches in large checkouts, with
`checkoutWorkers` set to 2. `terminal.launchTimeoutMs` limits an individual
launch wait to 660,000 ms. A WebSocket not acknowledged within 30 seconds offers
retry instead of showing an indefinite connection spinner.

### Session diagnostics

The shared desktop style uses compact Segoe UI/system text, flat neutral
light/dark surfaces, thin gray pane boundaries, and blue focus accents. Explorer
and Review Board use a subtle neutral selection with a leading accent indicator;
cards and controls have restrained corners without hover movement or glow.
The base type scale is 12px body/tree text, 11px metadata, 14px section headings,
and 18px page titles, with 28px controls and 24px compact actions. Dialogs retain
a soft shadow. Explicit font, size, density, radius, accent and motion preferences
still apply; session text retains its separately configurable monospace font.

Desktop appearance choices are saved atomically in `appearance.json` under the
Electron user-data directory, independent of the backend's changing localhost
port. Theme mode (including **System**) and every appearance/terminal option
survive relaunches and synchronize across open windows. Existing settings in the
current origin migrate when first read. Browser-only use retains origin-local
storage. A write failure is visible in Appearance instead of claiming it saved.

The terminal status row distinguishes its connection from the CLI's own
**Working/Thinking** display. **Session diagnostics** shows backend heartbeat
age, time since terminal output, and whether input was acknowledged as written
to the PTY. An acknowledged write is not confirmation that the command finished.

Health probes run over the existing socket every five seconds without launching
AI work or writing to the CLI. A missing reply for 20 seconds or an input-write
acknowledgement missing for 10 seconds opens diagnostics automatically. After
30 seconds without output, the row reports the quiet interval; an idle terminal
is not labelled failed. Background windows pause probes and resume checks
without interpreting sleep as backend failure.

Native CLI connections do not expose structured provider/tool progress here.
The panel states that limitation: a spinner/redraw or healthy heartbeat is not
proof of model progress, and silence alone cannot identify the cause.
**Send Esc to CLI** requests an interrupt when the connection is responsive.
**Reconnect terminal** reattaches to the existing live CLI (or uses normal
startup if it has exited); it never replays a prompt. Resource shortages are
reported only through measured App resources, not inferred from a slow response.

### Bulk review completion

Single and bulk PR imports enqueue analysis as each checkout finishes. The shared run store
owns the bounded queue (three PRs across batches), rather than a mounted
tracker component, so closing or switching tabs does not strand pending PRs.
Import review intent is saved with the PR in the backend database, rather than
browser storage tied to a changing localhost port. On app startup, unfinished
imports rejoin the bounded queue; completed, failed, or explicitly reset queue
entries are settled rather than silently rerun. Shutdown-interrupted legacy
change graphs are recovered as unfinished imports. A graph cancelled by shutdown
is rebuilt once before analysis; repeated failures retain their actual cause.
Manual full reviews and retry actions also check change evidence first.
Whole-stream errors apply only to actual perspectives, and the UI does not
claim retries were exhausted when analysis never started.
The tracker shows live elapsed time, final batch wall time and per-PR review
duration; individual Review Board summaries show the latest full attempt time.
The tracker opens with the first imported PR and updates as more imports finish;
each row shows evidence preparation or active perspective activity. Individual
perspectives show actual analysis duration, excluding queue wait; evidence
preparation has its own clock. Section retries reset only the relevant timer.

Review Board summaries name the changed projects. Expand **Project details**
for paths, languages and other detected context; click **files changed** for the
changed-file/diff browser. Files without text diffs remain listed, and failed
file loading has a retry action.

A PR feature's dashboard links directly to the pull request and shows its
source/target branches, author, reviewed commit and changed-file count.
**Checkout details** reveals the local path and import time. Older imports
without saved branch/author metadata use the matching remote PR when available;
lookup failures retain the link and offer a retry rather than guessing values.

Finding cards use **Leave a comment** to open an editable confirmation dialog.
Nothing is posted until **Leave comment** is clicked. The dialog
shows the PR, exact agent-reported file and new/right-side line, and a code
preview. When a finding cites several commentable lines, choose one explicitly.
Older `file:line` references require confirmation of the diff side; ambiguous
filenames, missing coordinates and deleted/left-side locations are not guessed.
Rerun the perspective for precise evidence when no eligible location is available.
Posting checks the captured diff and reviewed commit against the stored review
and the live PR head. Stale findings must be reviewed again.

Only a successful post at the expected location resolves the local finding;
the remote PR thread stays open. Posting shows a spinner and blocks duplicate
submissions. Failures retain the edited draft and leave the finding open.
Before manually retrying a failed request, check the PR for a comment that may
have been accepted despite a lost response; posting is never automatically retried.

The bulk tracker counts successful perspective results, not merely finished
requests. Skipped perspectives are shown separately; partial failures and
interrupted streams never produce a full green Completed state. **Retry** is
available for failed/incomplete rows. Bulk review waits for the PR change graph
before discovering perspectives and starting analysis.

Opening another Review Board tab preserves results from the shared live run
when the commit, evidence revision and perspective set are unchanged. A new
revision clears obsolete results and progress together, so a blank board cannot
retain an old completed counter. Opening a board or bulk tracker only reads
existing state; it does not schedule another review. Import and startup recovery
own automatic scheduling. **Retry incomplete** reruns only unfinished sections;
**Reset** is the explicit way to prepare a new full review.

After every perspective completes successfully, the main action becomes a green
**Approve PR** button. It is disabled while the reviewed identity is unverified
or blocking findings remain. Confirmation submits a real approval to the Git
provider for the displayed commit; it does not restart analysis. Provider errors
stay visible without discarding completed results. The per-perspective review
marks and **Mark PR reviewed** remain local sign-off, not remote approval.

### Deleting Explorer items

Successful deletion closes the matching editor views and reconciles active and
split panes. Deleting a feature also closes descendant feature, session, agent
and bulk-tracker views and cancels their queued/running reviews. Detaching an
agent closes its matching attachment view. Failed deletions leave views intact.
Unrelated views remain open, including surviving orphaned features/sessions
after repository removal and sessions retained after ungrouping. Open bulk
trackers reconcile their PR membership when features are added, moved or deleted.

Worktree cleanup remains asynchronous. Settings refreshes its inventory every
three seconds and on window focus, including removals started by feature
deletion. Rows show queued/deleting state or the actual failure with **Retry
removal**. Shared PR checkouts are removed once, not once per session. Failed
cleanup retains the review location for recovery and is logged rather than
silently discarded. Leftover PR/task folders remain visible even if Git has
already unregistered them.

### Repository dashboard background work

Repository scans share a two-command Git limit and a 15-second deadline per
command. AI summaries share a separate one-at-a-time limit across dashboards,
leaving other app operations outside these queues. Configure these limits with
`repoInsights.gitConcurrency`, `repoInsights.gitTimeoutMs`, and
`repoInsights.enrichment.maxConcurrency`.

**Cancel** stops a scan and keeps results already displayed. Closing the tab or
switching its repository also cancels the request, including running Git work;
late results cannot overwrite a newer scan. Duplicate active scans of the same
repository are rejected. A provider whose termination is unconfirmed pauses
further dashboard AI analysis until the app restarts, rather than spawning
overlapping retries. Structural scanning remains available.

| Area | Purpose | Mounted? |
| --- | --- | --- |
| `workspace/` | IDE shell: `workspace-view.tsx`, `explorer.tsx`, repository-context status/viewer, `new-session-form.tsx`, `import-session-panel.tsx`. | ✅ |
| `feature-dashboard/` | Feature analytics: charts, `feature-tasks-panel.tsx`, `pr-review-panel.tsx`, `work-summary.tsx`. | ✅ (within workspace) |
| `skills/` | `skills-manager.tsx`, `skill-tagger.tsx`, `skill-chips.tsx`, `skill-kind.tsx`. | ✅ |
| `automations/` | Automations page: categorized monitor/subagent lists, prompt-based creation, lifecycle controls, run history, and planned-steps detail. | ✅ |
| `mcp/` | `mcp-manager.tsx`, `mcp-server-form.tsx` — categorized MCP configuration, capability-aware management and explicit tool inspection. | ✅ |
| `pr-review-page/` | `pr-review-page.tsx`, `change-graph.tsx`, `pr-comments.tsx` — dedicated PR review page opened as an editor tab. | ✅ (within workspace) |
| `settings/` | `settings-view.tsx`. | ✅ |
| `usage-dashboard/` | Charts/rollups for usage & credits by model/provider/day. | ✅ (within workspace) |
| `live-credit-meter/` | Live per-session credits/tokens meter. | ✅ (within workspace) |
| `feature-summary/` | Generate/show AI feature summaries. | partial |
| `feature-board/`, `session-panel/` | Legacy list/detail views. | ❌ |

## Shared folders

The left icon dock magnifies the hovered/focused icon and its neighbors without
shifting the layout. Reduced-motion preferences disable magnification. Use the
bottom-left **Hide icon dock / Show icon dock** button or **Toggle Icon Dock** in
the command palette to change its visibility; the choice survives restart and
does not collapse the Explorer. Global activity/error text appears only in the
bottom status bar; the top progress track is decorative.

The bottom **N active** button lists running workspace sessions plus IDE-owned
metasession instances, including warm capacity and cold runs. Warm operation
bookkeeping records are not counted twice. **Idle** means available, not
processing; **Warming** and **Stopping** are explicitly distinguished from busy
work. Unknown/offline inventories are not reported as zero.

Click a workspace session to select its existing terminal tab. Click an IDE
metasession for a read-only live debug window: project/feature, supplied task
label and purpose, provider/model, operation status, recent activity, bounded
output and errors. Idle instances explicitly say when no activity is available.
The window never launches a new AI turn, attaches an interactive terminal, or
sends input to a service-owned session. Prompts and tool arguments are omitted;
recognizable credentials in diagnostic text are redacted.

One polling cadence reads `/active-sessions`; only the selected debugger also
reads `/active-sessions/:id/debug`. Existing session-stream revisions refresh
the inventory without another SSE connection. Polling pauses in hidden windows
and rejects late responses after switching sessions. Metadata comes from current
instances and observed operation writes, not repeated historical transcript
scans. The backend `activeSessions` config owns `pollMs` (3,000),
`maxOperations` (512), `maxActivityLines` (60), and `maxTextCharacters` (12,000).

The bottom **App resource usage** button uses a compact gauge icon. Its small
usage bar reflects the higher of app CPU share and app RAM share; amber marks
measured host pressure. The tooltip distinguishes app CPU/RAM from host CPU/free memory.
Click it to open live app totals and a sortable/filterable process table with
roles, PIDs, parent PIDs, start times, CPU and working-set memory. Backend,
desktop/UI and child CLI processes are shown separately. Summed working sets
may count shared pages more than once; independently launched provider
processes outside this app's process tree are not attributed to it.
The themed dialog groups host CPU/RAM and drive capacity under **System**, then
app totals, **Processes**, and **App storage** under **App**. Process rows use
stable PID order by default, with optional CPU/RAM sorting. Their **Shared
storage** link leads to app storage; per-PID disk allocation is not fabricated.
Logs, cache and worktree actions and confirmations stay inside their category.

The same panel shows disk capacity/free space and scoped storage categories for
worktrees, app files, provider data, caches and logs. Expand a category to inspect
its paths and any scan errors. Unknown measurements are not rendered as zero;
partial storage totals and stale process readings are explicitly marked.
Storage is scanned asynchronously, less frequently than processes. One
coalesced UI read loop retrieves cached snapshots every ten seconds, or every
one second with details open, and pauses while the window is hidden.

**Clean logs** requires confirmation showing eligible locations, then reports
asynchronous progress and protected/busy files skipped. Log path sizes and app
storage totals decrease as deletions are confirmed. A bounded logs-only scan
remeasures remaining files before completion, including protected logs that
have grown; it does not wait for a new worktree/provider scan. Measurement
failures are shown explicitly rather than leaving stale successful sizes.
**Clear Electron HTTP
cache** uses Chromium's cache API and preserves cookies, sign-in, local storage
and session history. Other active/provider caches are measured but not deleted.
Cleanup does not delete worktrees, active logs, credentials or databases.
**Manage worktrees** opens Settings → Diagnostics and expands the
existing Worktree list. Individual removal requests show their own progress
and failures so other rows remain actionable.

Host pressure still reuses the existing health probe. A measured threshold,
not a request timeout or full worker queue, determines pressure. Missing,
expired or unreachable measurements produce an unknown indicator. The tooltip
also includes active/queued CPU work and limits when available.

The backend `resourcePressure` configuration samples every `sampleIntervalMs`
(default 2,000 ms), expires measurements after `staleAfterMs` (30,000 ms), and
uses `highCpuPercent` (90), `lowFreeMemoryPercent` (10), and
`highEventLoopDelayMs` (250) thresholds. The sampler is an OS/performance adapter;
the health endpoint only reads its cached measurements. CPU is utilization
across all logical processors over a sampling window, not process CPU or load
average. Lag is the maximum observed within that window, not a diagnosis of its cause.

Requests pending for ten seconds add **Delayed** and elapsed time to the
existing bottom activity indicator. Elapsed time tracks the oldest outstanding
request, not completion progress. Cancelled requests leave the activity store
without reporting a failure. Wait for recovery or retry failed reads; check
whether a save/action completed before repeating it. Existing view loaders and
timeouts remain in place.

| Folder | Contents |
| --- | --- |
| `app/` | API context / shared API client wiring (`api-context.ts`). |
| `components/` | Reusable primitives: `ui.tsx`, `icons.tsx`, `terminal-view.tsx`, `model-picker.tsx`, `provider-picker.tsx`. |
| `hooks/` | Data + live-stream hooks: `use-usage-stream.ts`, `use-workspace-stats.ts`, `use-ide-usage.ts`, `use-async.ts`. |
| `lib/` | API client + helpers: `api.ts`, `stream.ts`, `types.ts`, `format.ts`. Tested; UI coverage gate targets `lib/`. |
| `styles/` | `design-tokens.css`, `app.css`. Use existing CSS variables/tokens; avoid undefined vars. |

## Repository context UX

The left Explorer uses compact, single-line rows with a consistent indentation
step and parent/child guides in both themes. Folder, pull-request, terminal and
agent icons identify node types. Hover a session for its status, model, credits
and active time; focus or hover its row to reveal the usage action. The session
chevron expands changed files (loaded on demand) and attached skills. Agents are
ordinary child rows, not a separate card. Account sign-in/out controls are under
the collapsed **Accounts** disclosure. These density and palette rules are
scoped to the Explorer, leaving the editor and other views unchanged.

Each saved repository row in the Explorer shows a live context badge:

| Backend status | UI label | Behavior |
| --- | --- | --- |
| `pending` | Pending | Spinner; new repository-backed sessions are disabled. |
| `generating` | Analyzing | Spinner; sessions remain disabled. |
| `ready` | Ready | Sessions are enabled. |
| `stale` | Refreshing | Spinner; the checkout changed and sessions remain disabled until regeneration succeeds. |
| `failed` | Failed | Failure text is shown; sessions remain disabled and the viewer offers **Retry**. |

Click the badge, or choose **View context** from repository actions, to open `workspace/repository-context.tsx`. The viewer shows source revision, generated/updated timestamps, lifecycle state, failure details, and the generated summary. While analysis is in flight it shows an animated "Analyzing repository" banner (`role="status"`) plus a step checklist (`collect-evidence` → `analyze` → `persist`) that marks each step running/ok/failed/skipped in real time, so it is clear what the app is doing and exactly which step failed. If a later attempt fails, the last successful summary remains visible with an explicit warning. **Refresh** starts a background generation request; while the request is being accepted the button is disabled and inline API errors are shown. A failed state changes the action label to **Retry**.

The Explorer initially fetches `GET /repos/:id/context` for every repository. It then consumes `repository.context.updated` from the shared SSE stream and keeps the newest record by `updatedAt`, so pending/analyzing/stale/ready/failed transitions appear without polling. Adding a repository triggers generation on the backend; manual refresh uses `POST /repos/:id/context/refresh`.

For a feature attached to a repository, the new-session `+` button is disabled unless context is `ready`. A status message explains whether analysis is pending, running, refreshing after a checkout change, or failed. If readiness changes while the new-session form is open, the form closes. The backend repeats this readiness check, so stale UI state cannot launch an unbootstrapped development session. Features without a repository are not gated; importing past sessions is also unaffected.

When a development session launches, the UI does not assemble context itself. The backend supplies a fresh bootstrap containing repository context, feature details, prior completed development-session summaries, and effective skills. Repository-analysis runs are hidden from Explorer/session SSE, while their usage appears in the existing **IDE AI** accounting view.

## Workspace continuity, focus, and analytics

Workspace tab order and the active tab survive top-level navigation and restart;
deleted entities are pruned. Settings retain dirty namespace drafts across
navigation and unrelated saves, with explicit conflict/discard handling.
Schema controls have stable scoped labels, descriptions, and error associations.

Dialogs retain intentional initial focus and trap keyboard navigation. Focus is
restored only to a still-valid owner; replacing or disconnecting a terminal
invalidates its captured focus token even when its DOM textarea is unchanged.
Terminal autofocus does not override an open dialog or another explicit target.
Disabled fieldsets and hidden/inert ancestors are excluded from focus targets.
App and OS reduced-motion preferences suppress decorative motion.

Terminal pane fitting is deferred while selection, dragging, or replay rendering
owns the viewport. Clearing selection or releasing a drag applies the latest
pending size without requiring another resize event; window blur releases a
lost drag. Replay completion uses actual xterm write callbacks, not a guessed
delay. The exit footer provides a finite rendering fence for both live exits
and replayed closed sessions, while input remains governed by backend readiness.
Deferred interaction timers retain only active handles.

Feature analytics load a **manual snapshot**, showing the last successful load
time and a **Refresh usage** action. A failed refresh retains the same feature's
previous snapshot with an error; switching features cannot display the old
feature's data or accept its stale response. This dashboard does not open an
additional usage stream or rescan live history on each render. Live session
meters and other SSE-backed surfaces remain separate.

## PR review UX

Engineering Review sign-off is bound to the authoritative board's repository,
PR, reviewed commit and evidence revision. Navigation/focus return revalidates
that identity without starting another AI review. A failed refresh temporarily
blocks certification but preserves decisions; retrying the same identity restores
them. A changed identity archives prior approvals and clears current sign-off;
a missing identity blocks certification without discarding decisions. Legacy
identity-free approvals cannot certify new code.

A feature created from a pull request renders a **PR review panel** (`feature-dashboard/pr-review-panel.tsx`) inside its dashboard. On mount it fetches `GET /features/:id/pr-review`; a `404` means the feature is not a PR review and the panel renders nothing. While generation is in flight it shows an animated "Analyzing pull request…" banner (reusing the repository-context spinner/dots). When ready it shows the **PR Summary** and **Core Analysis** sections; on failure it shows the failure detail and a **Retry** control. The panel consumes `pr.review.updated` from the shared SSE stream and prefers live state over the initial fetch, so lifecycle transitions appear without polling. **Refresh** calls `POST /features/:id/pr-review/refresh` to regenerate the review; the previous summary is retained for viewing if a later attempt fails.

Opening a PR review as its own editor tab renders the full **PR review page** (`pr-review-page/pr-review-page.tsx`), which adds the per-file **change graph** (`change-graph.tsx`). The graph is a static reference graph of PR-modified functions and their connections; it supports **zoom, pan, internal scroll for large graphs, and full-screen**, plus a **show/hide callers** toggle. Selecting a node opens a detail popup with that file's **code diff** and inline **PR comments** (`pr-comments.tsx`). The page exposes **Approve** (casts the signed-in reviewer approval on GitHub or Azure DevOps), **Re-run all**, and per-step **Retry** controls; re-running re-collects diffs, so reviews generated before a diff-collection fix repopulate their per-file diffs.

## MCP server management UX

The **MCP Servers** view (`features/mcp/mcp-manager.tsx`) separates **Agency**,
**Copilot CLI**, **Claude Code**, and **This app** in the **Category** selector.
Categories are independent of which AI providers are enabled for new sessions.
Within each category, cards are grouped into **App MCP servers**, **Agency
built-in MCP servers**, and **Custom MCP servers**. Tags describe the server's
actual provider, not the configuration file that references it: the Studio
bridge is tagged **This app**, including inherited Agency/Copilot registrations.
Cards identify their configuration source and scope separately. Source notices explain
which inventory is included; file-derived entries are not presented as a
complete inventory of a running CLI's plugins, built-ins, managed policy or
session-only overrides.

The Agency category also lists its available, documented built-in MCP servers
as concise cards under **Agency built-in MCP servers**. Built-in cards show
the server name and description, with three actions: **Tools**, **Auth/Reauth**
and **Configure**;
they omit repeated provider badges, raw source commands and capability tables.
These catalog entries come from
the installed CLI's advertised offerings, not fabricated configuration entries.
Unconfigured entries offer **Configure**, separate from the configured-entry
count. Resolved and global declarations of the same built-in are combined
into one card. Different declarations retain their provenance and are protected
from ambiguous edits. **Configure** opens a concise form for server-specific arguments, shows
the native command, and executes `agency config set --global --mcp "<spec>"`
from the IDE when the user confirms. Setup verifies persisted global
configuration before refreshing the list or claiming success. Configure is
separate from tool inspection and authentication. Saving alone does
not start the MCP server, complete authentication, or restart existing sessions.
Errors retain the argument draft; duplicate submissions are blocked while
the operation runs, and mutations are never automatically retried.
Editing a scoped global built-in shows its current saved settings and warns
that native reconfiguration replaces its options and may re-enable it.
The user must supply all desired arguments; existing settings are not
silently converted into guessed command-line flags.
The options picker suggests flags and values from cached installed-CLI help,
with background cache refresh rather than repeated help calls on every click.
Users enter server options, not a second `agency` command. The preview includes
the fixed command and server name once; pasted full commands are rejected with
a short correction.
The filter searches names, descriptions and source
labels. Configuration notes are deduplicated and collapsed so the server list
remains the primary content.

**Supported operations and limitations** lists the capabilities of each
category and entry. Add/edit, confirmed removal and server enablement
are available only when that source supports them. Unsupported controls
remain disabled with a reason and native-CLI guidance where applicable.
Configuration editors preserve provider-specific JSON fields and variable
references instead of imposing Copilot's schema on other CLIs.

Configuration listing never starts an MCP process or authentication flow.
**Check connection** and **Tools** explicitly request independent inspection;
native server startup may invoke Agency's normal sign-in flow. There is no
universal separate Agency MCP login command, and tool listing is not guaranteed
to be authentication-free.
A successful probe does not prove that a running CLI is connected, and it does
not reconnect that CLI. App-owned tool definitions are separate from external
server connection state. Changes apply to future sessions unless a supported
operation explicitly reports otherwise; the manager does not inject restart
commands into active conversations. Native MCP authentication and reconnect
flows remain in the appropriate CLI when this app cannot safely control them.
The tool inventory is read-only: names and descriptions, with refresh/retry,
but no enablement checkboxes, restart actions or capability editor. Authentication
is not inferred from a timeout or from successful configuration. A reported
sign-in requirement can expose a supported authentication action; opening a
sign-in page does not mark the server authenticated. Recheck to observe the result.
Successful tool discovery without a sign-in challenge does not prove that every
tool has permission to run.
Tool loading shows an animated spinner and the current operation, plus the
actual launch command when safe preview metadata is available. It does not
invent arguments from the card name or conceal failures behind a skeleton.
**Auth** is disabled unless a check reports that sign-in is required.
Required sign-in enables a red **Auth** button; an observed expiry enables red
**Reauth**. Unknown or unchecked connections stay disabled; **Tools** checks
the connection and updates the action. A successful check disables Auth again.
The app-owned connection needs no separate sign-in. Timeouts are unknown/error
states, not evidence of token expiry.

**Connect and authenticate**, or **Continue Agency sign-in** for an observed
challenge, starts an asynchronous connection attempt, retaining the native
process while it initializes and lists tools. The IDE polls progress and shows
reported browser links/device codes only while that job is pending and
unexpired. Closing the view requests cancellation, including when the start
response arrives late; there are no automatic authentication retries. The
default deadline is 120 seconds. A completed job updates tool inventory rather
than asserting permanent or universal authorization.

**Check all configured servers** provides a single workflow for enabled,
configured built-ins. It reports per-server progress and separates verified
tool discovery, observed sign-in requirements and unknown/failure states.
**Reauthenticate required servers** proceeds through supported challenges
after explicit confirmation, keeping only one native sign-in job active.
Agency may reuse cached credentials, but different MCP servers can require
different resources, permissions or accounts. There is no shared "all MCPs
authenticated" flag or inferred token-expiry schedule; a new challenge prompts
reauthentication when observed.

Native tool discovery launches the documented `agency mcp NAME` protocol
process with verified options explicitly preserved. That standalone command
does not merge persisted built-in options. Unsupported option shapes are
reported instead of silently connecting with defaults.

Lists and dialogs belong to the selected category, and switching categories
closes old dialogs and rejects stale completions. Failed loads offer retry rather
than an empty-state claim. Save errors remain inside the editor with its draft;
failed tool probes clear stale inventory and retain explicit errors. Server
enablement uses independent per-card progress; one slow operation does not lock
the category selector or unrelated cards. Removing configuration requires
confirmation, does not uninstall the server, and does not claim to clear stored
OAuth credentials.

Provider behavior is checked against official documentation:
[Copilot MCP setup](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers),
[Copilot CLI reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference),
[Claude Code MCP](https://code.claude.com/docs/en/mcp), and
[Claude managed MCP](https://code.claude.com/docs/en/managed-mcp).
Agency uses its current published `docs/agency/Tools/MCP/mcp.md` and
`docs/agency/CLI/agency-config.md` documentation. Installed CLI versions may
expose fewer operations than rolling documentation; unsupported command or
configuration shapes must fail explicitly without modifying the source.

Agency built-in setup uses the native `--mcp` parser rather than a generic JSON
object setter, because generic setters differ between TOML and YAML. Resolved
raw/custom entries without stable writable-source provenance remain read-only;
the IDE does not guess which inherited file to rewrite. Copilot
and Claude configuration scopes retain their own capabilities; native session
toggles, authentication and reconnect actions are not emulated with invented
configuration fields.

The app-owned Studio bridge has a bounded health check, including protocol/tool
discovery and authenticated access to this app. Recovery retries once and can
repair a recognized stale app-owned registration; it never uses AI remediation,
restarts unrelated sessions, or reports static tool definitions as a live
connection. Persistent failures retain the actual diagnostic instead of forcing
a passing state. Windows command-shell launch specifications preserve quoted
executable paths containing spaces.

## First-run installation

The Agency setup gate always offers **Continue without waiting**, including
during status checks and installation. A status check is bounded to 15 seconds;
failure or an incomplete response does not mean Agency is missing and does not
start installation. After 30 seconds without installer output, the gate reports
stalled progress while continuing to listen for completion.

Deferral closes the progress stream, not the installer process. If the stream
disconnects, the gate reports an unknown outcome and **Check again** rechecks
installation status without starting another possibly concurrent installer.
Agency-dependent features may remain unavailable. Recent output is limited to
200 lines, with oversized lines explicitly marked as truncated.

## Automations UX

The **Automations** view (`features/automations/`) manages workspace-global
monitors and subagents. It offers a prompt entry point that starts a metasession
to set up and run an automation, and it also reflects monitors registered by an
in-session AI through the Studio local MCP bridge. Monitors are grouped by mode
(`short` or `long`) and status; subagents appear in their own category.

Monitor cards show name, mode badge, status, origin, progress, planned next
steps, last check result/time, next-run countdown, and run count. Controls call
the `/api/automations` lifecycle endpoints for **Pause**, **Resume**,
**Cancel**, **Run now**, and **Delete**. Opening a detail view shows run history,
retained report output, and the planned-steps timeline.

The view consumes `automation.updated`, `automation.removed`, and
`subagent.updated` from the shared SSE stream so status, progress, run counts,
and planned steps update without polling. Automation AI work is internal and
therefore hidden from workspace session lists while still appearing in **IDE AI**
cost accounting.

## Conventions

- Keep testable logic in `lib/` (parsing, formatting, stream state) — that's where the UI coverage gate applies.
- Use the shared pickers/components rather than re-styling per feature; compact "IDE desktop" styling lives in shared classes (e.g. `picker-field`).
- Reference CSS design tokens from `styles/design-tokens.css`; don't hardcode colors.
