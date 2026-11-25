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

The main window stays hidden until React restores the initial view, its lazy
panels, console connection and visible prompt history, then paints. A
sender-scoped readiness signal replaces the premature HTML-load handoff, so
individual component skeletons stay behind the one animated startup screen.
Provider selection and recoverable loading errors remain actionable rather
than waiting for an impossible successful load.
Startup errors remain visible with an explanation and a close control. Closing
the startup window uses the same cooperative backend shutdown as the main app.
Missing Node.js or an early backend exit is reported immediately rather than
waiting for the readiness timeout. Cold backend initialization has a bounded
120-second readiness budget, separate from the interface's 30-second budget.
`CW_STARTUP_TIMEOUT_MS` explicitly overrides both. Readiness still requires the
spawned child's launch identity and compatible protocol; waiting longer never
replaces a live child or adopts another server on its port.
Startup failures write a bounded
`desktop-startup.log` in the desktop user-data directory; the error shows its
location. Each failed launch replaces that diagnostic file.

If no backend process could be started, the desktop closes normally. If the
backend has already exited without confirming cleanup, **Close app** is available
in a warning dialog. This closes only the desktop; it does not claim cleanup
succeeded, restart the backend, or launch an installer. **Keep open** preserves
the error screen without an ongoing closing animation. A still-running backend
continues to require cooperative cleanup.

Normal close, relaunch and update cleanup show one opaque **Closing AI Project
Studio** screen, with a themed power emblem, a gentle orbit animation, an
indeterminate loading bar and a friendly wrap-up message. It explicitly waits
for shutdown confirmation rather than claiming that cleanup already finished.
The workspace stays mounted beneath it, so disconnected panels do not
flash while services stop. A cancelled or failed close restores the existing
interface. Reduced motion is respected; no fake completion percentage or
artificial shutdown delay is added.

Development launches connect to the existing server rather than spawning a second
backend. Assets and the isolated preload live in `desktop/startup/`; lifecycle
coordination is in `desktop/startup-splash.cjs` and `desktop/main.cjs`.

## What's actually mounted

The Explorer header's **Locate active tab in Explorer** icon reveals the active
workspace tab in the tree. It expands the relevant repository, parent features
and nested folders, then scrolls to and highlights the session, feature,
repository or attached agent without switching tabs. Review batches locate their
parent feature. Other branches retain their expansion state; unavailable items
report a short status instead of opening a different item.

The CLI picker sits immediately above the theme icon in the activity bar and
is also available in the command palette. **Ctrl+Shift+L** (Windows/Linux) or
**Cmd+Shift+L** (macOS) opens it even while the embedded terminal is focused;
IME composition, existing dialogs and ordinary text composers retain ownership.
Settings → CLI can change the chord to **Ctrl/Cmd+Shift+Y** or disable it.
Agency appears automatically when the internal-network probe succeeds, and is
hidden otherwise. Network visibility is not authorization: Agency still
enforces its own authentication. Microsoft sign-in alone never exposes it;
Copilot and Claude require no Agency installation or internal credentials.

Each CLI has an initially collapsed **IDE feature readiness** checklist.
Settings groups **Installed** and **Not installed** CLIs with each provider
collapsed initially. Expand a provider for its configuration; installation
instructions and documentation live behind small information buttons.
CLI preferences, switching requirements and other tools are collapsed separately.
The chooser uses separate, padded provider cards and shorter action labels;
Agency is labelled **Microsoft internal only**. Diagnostic details are
collapsed separately. These are Studio readiness states, not a native CLI
capability score.
Amber warnings mean supported features need installation, credentials or other
setup; a pending check is not reported as unsupported. **Studio integration
needed** is an amber application-integration state, not a red unsupported
native feature. A missing Claude installation is setup-required, not unsupported.
The chooser scrolls within the window when lists are expanded or zoomed.
Native-style icons distinguish CLIs, installation status and actions without
relying on color. Cards have a short staggered entrance and checklist expansion
fades in; OS reduced-motion and Studio Reduced/Off settings disable this motion.
The chooser's ready heading uses a terminal icon, not a perpetual loading symbol.
Unavailable AI controls are hidden by default; Settings → CLI →
**Show unavailable IDE features (experimental)** reveals them without claiming
support or starting any work. Attempts can still fail, and backend/native
safety checks remain enforced. Manual planning, PR imports, and configuration
remain available.

CLI readiness also distinguishes interactive from automated execution. Agency
and Claude use native CLI configuration and permissions for agents, summaries
and planners by default; invoking these features can start native MCP servers
or request native sign-in. Text-only tasks still explicitly disable model tools.
Copilot-backed prompt mode includes its mandatory startup approval flag, but
an empty available-tool list and deny-all rule override it for no-tools turns.
The `mcp.headlessPolicies` setting selects `native` or `isolated` for each CLI;
restart after editing. Copilot defaults to isolated mode. Optional isolated
Agency refuses unverifiable zero-MCP startup; isolated Claude requires supported
API/cloud credentials and no conflicting managed MCP configuration.
Claude's native version and sign-in are verified only after it is selected; a
dormant provider is not falsely described as having invalid credentials.
A registered/installed provider is not a promise of every capability.

Startup asks which eligible CLI to use. **Remember me** is opt-in; remembered
legacy choices continue to work. Settings → CLI exposes this preference,
installation commands, executable/argument configuration and default models.
Switching requires confirmation before stopping interactive CLI work. Save
unsent text first. The switch waits for confirmed exit, refuses unsafe
background work, and preserves every provider's sessions and history. In the
current feature it resumes the newest compatible conversation or opens an
empty new session; it never submits another provider's old prompt.

`ui/src/App.tsx` renders eight top-level views (selected from the activity bar):

- **Workspace** (`features/workspace/`) — the IDE shell: explorer sidebar, session tabs, embedded terminal, new-session form, import-session panel, feature dashboard tabs.
- **Planner** (`features/planner/`) — dated tasks/backlog, imports, summaries, exports and workspace launch recovery.
- **Skills** (`features/skills/`) — manage/tag reusable instruction skills.
- **Automations** (`features/automations/`) — monitor and manage background monitors and tracked subagents.
- **MCP Servers** (`features/mcp/`) — manage Model Context Protocol servers and their tools per provider.
- **Usage** (`features/usage/`) — workspace/IDE metasession analytics and retained usage.
- **Agents** (`features/agents/`) — Review Board, New Task and Bug Bash prompts/configuration/usage.
- **Settings** (`features/settings/`) — app configuration.

> **Not mounted (legacy/dead):** `features/feature-board/`, `features/feature-detail`, and `features/session-panel/` are not reachable from `App.tsx`. Treat them as historical; don't rely on them for current behavior.

## Feature areas (`ui/src/features`)

### Planner import filters

Import tasks supports ADO work items/PRs and GitHub issues/PRs. Both PR sources
offer **My PRs**, **Assigned to me**, **All PRs**, and **Team**, matching Open
Pull Request. My/assigned/all scopes use the existing provider query; Team
refines the returned all-PR list using the same saved roster and review-age
ordering as Open Pull Request. GitHub issues offer my/assigned/all server scopes.
Each source keeps its saved scope separately.

ADO work-item assignment, state, area, iteration and tag filters are sent together
on **Apply filters** (or Enter), not on each keystroke. Area/iteration include
children; a blank state excludes completed states. Work items belong to the
repository's ADO project, not only that repository. Applied facets are saved.
**Reset filters** restores assigned-to-me work items or all open PRs/issues;
it does not erase the shared team roster.

Every source also has an explicitly labeled **Search loaded …** field, applied
on submit. Search and Team are local refinements, not repository-wide searches:
providers may cap returned lists. The dialog explains this and shows
shown/loaded counts; narrow server scopes/facets to retrieve a different set.
Changing sources/repositories clears local search and selection. No unsupported
provider search parameters or implicit searches over truncated lists are used.

### Usage time frames

**Day**, **Week**, **Month**, and **Year** select the current UTC calendar
period, not just chart grouping. Weeks start Monday. Cards, model/provider/MCP
breakdowns, the activity calendar, skill activity, and operation insights share
the displayed date window in both Workspace and IDE scopes. Shorter periods
use daily buckets; Year uses monthly buckets. Date ranges have an exclusive end.
While refreshing, the previous snapshot keeps its original window label;
failed or late requests cannot relabel or replace it with another period.

KPI numbers ease to new measured totals over 400 ms. Reduced/off motion updates
immediately, screen readers receive the exact final value, and unavailable
billing is never displayed as a zero. The bounded metasession feed filters by
usage-capture time, not operation-start time, and is not a complete usage ledger.

### Prompt usage

Each editable and read-only entry in **Settings > Prompts & Commands** has a
small Usage icon. It opens **Usage** with that prompt selected. **Prompt usage**
uses the displayed UTC time frame and covers IDE template requests plus
workspace skill context independently of the Workspace/IDE accounting tabs.
Opening, editing or saving a template does not record a use or start AI.

New task-plan, summary, repository-analysis and settings-assistant requests
persist stable template identities with their operations, including failed
attempts. Skill context records **prepared** separately from successfully
**injected** instructions/removals; neither claims model invocation. Custom
skill removal text does not count as use of the default removal template.
No prompt text is added to the attribution ledger, and earlier requests remain
unattributed rather than being presented as zero usage.

The view charts events by day and reported tokens/AIC by request, showing
unknown metering as gaps. A request using multiple templates is counted once
in **All attributed prompts**; its per-template metrics represent shared
participation, not additive spend. Reused warm sessions use immutable
request-response metering, never whole-session totals; unavailable per-request
billing stays unavailable. Dedicated cold operations may receive late captured
usage. The latest matching events are bounded by `metaOperations.maxPageSize`;
truncation and reported/total counts make partial charts explicit. **Refresh
prompt usage** rereads the ledger without starting any operation. Unified
Usage totals remain the accounting authority.

### Monitor check outcomes

**Watching** means the monitor remains scheduled, not that its latest check
succeeded or the watched task finished. A failed check leaves its condition
unknown; the card distinguishes that failure from the next scheduled retry.
Timeouts show a readable duration and preserve unconfirmed CLI-shutdown warnings.
Missing provider diagnostics are explicitly unavailable, not guessed to be an
authentication or task failure. Raw errors remain under **Technical details**.
Logs distinguish **Checked** (including a negative verdict/no action) from
**Action completed**, **Check failed**, and **Action failed**, without repeating
“Checked” prefixes. Opening logs never runs a check.

### Session names

**Rename** prefills and selects the current displayed title, including generated
titles. Names are limited to 120 characters; Enter saves and Escape cancels.
Persisted names remain authoritative after refresh/reload even when an older
live session snapshot still contains the generated name. Runtime status and
other live fields continue updating.

### Skill and MCP telemetry

**Usage** and feature dashboards show skill activity separately from MCP servers.
The skill table filters **Repository**, **IDE**, **CLI**, and **Not identified**
sources and keeps same-named skills from different repositories/providers
separate. Repository worktree copies share their repository-relative skill
identity. CLI and repository invocations come from explicit `skill.invoked`
events, not guesses based on prompts, file reads, or available skill lists.
Historical and live events share the existing bounded provider-log reader;
durable event identities prevent replay double-counting.

IDE library skills record **Context prepared** at development bootstrap and
**Context injected** only after a successful live-terminal injection. These
are guidance-delivery activities, not proof of model execution, and are never
merged into CLI invocation counts. Merely tagging a skill does not count as
an invocation. Historical IDE applications before telemetry was enabled are
not reconstructed from today's attachments.

Each skill shows uses, distinct sessions, last activity, and tokens/AIC only
when explicitly attributed to that skill. Unknown usage is **Not reported**;
measured zero stays zero, and incomplete metric coverage is marked **partial**.
Session/turn totals are never allocated between skills or MCP servers.
MCP tables and rankings no longer show model-token metrics.

Skill snapshots cover the latest `skillUsage.maxEvents` events in the selected
workspace, IDE-metasession, or feature scope (5,000 by default, capped at 10,000).
In Usage, the selected calendar window filters events before aggregation and
limiting. Standalone feature dashboards retain their independent recent-event
window. A notice identifies truncated history; older events remain persisted.
**Refresh skills** reloads the snapshot.
Payloads and skill contents are not persisted by this telemetry.

### Session checkout and startup

New non-PR sessions use the repository's existing checkout on its default branch.
Sessions under a feature with one planned New Task reuse that task's worktree;
PR sessions reuse the feature's existing PR checkout. Normal session startup does
not clone, fetch, add a worktree, generate a session branch or detach HEAD.
Multiple sessions share the same working directory: branch changes, commits
and edits are visible to all of them. Branch selection is serialized per
checkout to avoid concurrent index locks. Git refuses a switch that would
overwrite local edits; the app never resets or stashes them. Existing managed
checkouts always keep their current branch and files, without a replacement
confirmation. A deleted checkout is restored automatically from its last
registered Git HEAD (including detached commits), or its recorded branch if
that metadata is unavailable. If neither is available locally, recovery fetches
the recorded ref, falling back to remote `master`, and creates a worktree at
the original location. Recovery uses detached HEAD so it cannot move a branch
used by another checkout. Deleted uncommitted files cannot be reconstructed.
Locks, permissions and fetch failures are reported; no checkout is discarded
or unlocked automatically. The primary clone is never replaced. See [New Task](features/new-task.md#where-the-work-lives)
for recovery behavior. When several task checkouts exist, the terminal asks
which branch/path to use and remembers the selection for that session. Cancel
leaves the session unbound. Cross-feature moves offer a destination worktree
picker and clear the previous binding without deleting its checkout.

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
replaying input. A `master` recovery fallback is explicitly shown in startup progress.

`sessionWorktree.gitTimeoutMs` defaults to 20,000 ms for metadata commands;
`checkoutTimeoutMs` is 600,000 ms for switching branches in large checkouts, with
`checkoutWorkers` set to 2. `terminal.launchTimeoutMs` limits an individual
launch wait to 660,000 ms. A WebSocket not acknowledged within 30 seconds offers
retry instead of showing an indefinite connection spinner.

Optional repository-context refresh does not hold CLI startup indefinitely.
`repositoryContext.launchContextWaitMs` defaults to 250 ms; a slower refresh
continues in the background and the session starts without that optional
context. Delays and failures are logged. This budget does not bypass checkout
readiness or provider authentication.

### Prompt and task editing

**New session** accepts an optional initial prompt. Ctrl+Enter on Windows/Linux
or Cmd+Enter on macOS opens the session; confirming an IME candidate does not
submit. An empty prompt is omitted. The backend sends a saved initial prompt
only on the first terminal launch, not when reopening or recovering a session.
Creation errors preserve the prompt. Cancel is disabled during creation;
Escape cancels only an empty, idle form.

If a new primary/shared-checkout session cannot switch branches and Git
confirms unresolved index entries, it opens the existing checkout instead.
The launch message explains that conflicts remain unresolved; no files or
index entries are reset, discarded or automatically resolved. Managed
task/PR checkouts are never redirected to a different branch.

Planner title/notes and New Task problem/context drafts survive view switches.
A late server response does not overwrite dirty or restored text, and a
successful save clears only the version that was saved. If local draft backup
is blocked or full, a warning asks the user to save or copy the text before
leaving. This warning is separate from backend save failures.

Planner's radar icon glows when auto tracking is enabled and pulses only
while processing recorded work (without animation under reduced motion).
Click it for a compact status panel with running/queued counts, the configured
check interval, workspace and repository names, enqueue/start times, and the
active phase (reading recorded activity or analyzing evidence). Evidence and
session counts appear only after a source snapshot has been read; these are
records considered, not a percent-complete estimate. The bounded queue holds
up to 16 waiting workspaces plus the active pass. Discovery can reorder work;
the list is not a promise of strict FIFO processing.

The last pass shows whether tasks were refreshed, evidence was unchanged or
absent, the workspace disappeared, a pass was cancelled, or a retry is waiting.
Retry times are earliest eligibility, not a guaranteed start; rediscovery or
new activity schedules another check. Queue entries are retained while paused.
Polling failures hide stale active/queue details and label the last result as
last-known. The collapsible explanation retains the credit/evidence caveats.
Errors and the last successful update are shown in local time. No update this launch can mean there
is no new evidence; an unchanged timestamp alone does not indicate failure.
Updates reflect successful tracking passes, not independently verified task
completion. Status refreshes every 15 seconds while the window is visible.

Use **Export > Tracked work by period...** to download generated tracked tasks
for a selected day, Monday-Sunday week, or calendar year as Markdown, JSON, or
CSV, without another AI request. The reference date selects the period, using
assigned Planner dates across all repositories. Open and completed tasks are
included; backlogged and deleted tasks are excluded. Notes and current status
are exported, but raw transcripts and tracking evidence are not. Reported
completion is not independently verified. Ordinary day exports remain available.

Planner suggestions support arrow keys, Enter and Escape. IME composition does
not add or rename a task, repeated submission is guarded, and failed mutations
leave edits available with an error. Deleting a planner entry asks for
confirmation; linked workspace features and sessions remain intact. A temporary
reopen failure does not silently launch another task. An uncertain create
outcome is surfaced for reconciliation rather than blindly duplicated.
Launch ownership and reconciliation state survive switching views within the
same app window. Returning to Planner shows an existing launch instead of
starting another, and a launch started by a departed view does not steal focus.
Opaque operation keys also survive a full window reload, so retrying the same
unresolved create can recover the original resource instead of duplicating it.
Keys contain no prompt text. Unresolved intents are retained rather than
silently expired; reaching the bounded local capacity blocks new intents with
an explicit error. Damaged retry storage also blocks new creates and preserves
its original bytes: check the workspace for earlier operations before recovery,
instead of silently losing their retry identities.
If local cleanup fails after a confirmed create, the resource
still opens and a dismissible warning remains visible across view changes.

New Task supports Ctrl/Cmd+Enter to plan. Active-run fields remain readable and
selectable. Cancel waits for server confirmation before detaching the live
stream, so a failed cancel cannot make a running task appear idle. **New
session** opens the created session in a workspace tab and carries the saved
task problem/context as its initial prompt. Activity, diff and planner summary
dialogs use the shared Escape, focus-trap and focus-return behavior.

### Prompt history

The session's Prompt history pane includes a search box that instantly filters
the full prompt and response text, ignoring case and surrounding whitespace.
The docked pane and full-screen history share the same query and show matching
and total counts. **Clear search** restores the full list. Live polling keeps
the active filter applied as new prompts and responses arrive; changing sessions
clears the query. Loading, empty history, failed requests, and no search matches
remain distinct states.

Both history views list the newest prompt first, including live turns.
In a prompt's detail dialog, **Full screen** beside the response's copy/download
controls expands only the response to a screen-sized reader. **Restore** returns
to the prompt-and-response view; Escape or Close dismisses the dialog. Live
response updates and copy/Markdown/HTML exports remain available while expanded.

History requests are cancellable and time-bounded. A failed refresh retains the
last loaded turns with a stale-data notice and **Retry**; an unavailable CLI
store is an error, not an empty history. Polling pauses while the window is
hidden and resumes on visibility or network recovery. Session changes cancel
the previous request and clear its search and selected detail.
Failed live-log reads also return an unavailable error rather than replacing
a newer live turn with SQLite history that may be one turn behind.

### Explorer feature hierarchy

**New feature** in a subcategory's Add menu places only the new feature inside
that folder. Existing subcategories keep their owning feature, including nested
folders and after reloads; creating a feature does not move those records.

Recursive feature rows use stable feature-ID keys, not list positions. Inserting
or reordering siblings must not transfer loaded folders or persisted expansion
state between features, even when a new feature's folder request is slow or fails.

### Session diagnostics

Explorer usage badges use one background workspace snapshot, not one request
per collapsed feature. Features include nested features and subcategories;
subcategory totals also include features placed inside them. Badges keep tokens
available when charges are unknown: measured zero is `0`, partial charges are a
`>=` lower bound, and unavailable or not-yet-recorded charges are `n/a`.
Click a badge for input/output/reasoning tokens, charge reliability, missing
usage counts and reported USD estimates. Deleted sessions remain in feature
totals and appear as retained usage in the feature dashboard.

Explorer usage controls show only the shared usage icon, leaving room for item
names at every sidebar width. Hover for exact credits/tokens and billing status,
or activate the keyboard-accessible button to open full details. Icon-only
presentation never changes accounting.

Summary invalidations are throttled to one request per second, including
meta usage, stream reconnects and hierarchy changes. Failed refreshes keep the
last snapshot with an explicit stale notice and **Retry usage**. Snapshot queries
and hierarchy folding run in a bounded, cancellable worker; prompt-history
log scanning uses a separate bounded worker pool. History scanning is limited
by `copilotHistory.livePromptMaxScanBytes` (16 MiB by default).

Terminal replay retains viewport boundaries instead of interpreting all
cursor-addressed output at the latest width. `terminal.maxReplayGeometryBoundaries`
defaults to 128; older replay segments are trimmed when this limit is reached.
Clipboard failures are visible, and a delayed native write cannot overwrite a
newer copy or restore text after a clear. Native Windows/Mac clipboard and
renderer qualification still requires the installed-desktop regression checks.

Input stays in the **native console**; there is no separate prompt editor or
second draft/history store. There is no bottom input toolbar. A small
**Clear input line** icon sits at the bottom-right in a reserved gutter outside
the terminal text grid, without consuming console height. It sends Ctrl+A then Ctrl+K
to clear the current input line, including when its cursor is in the middle.
Use it at the CLI prompt; it does not send Enter or Ctrl+C, clear output, or
delete history. Multiline input remains owned by the CLI. History remains in
the existing **Prompt history** pane and the CLI's native recall shortcuts.
Multiple prompts can be submitted while a reply is running. History retains
each recent live prompt until the CLI store catches up, associates replies by
native originating-message IDs rather than arrival order, and labels waiting
prompts as **Queued**. Turn completion and duration stay with the corresponding
answer even when later prompts were entered first. Open response dialogs keep
following the same prompt as it streams and is persisted.
The normal connected-status row is hidden; startup, failures, lost heartbeat
and unacknowledged input remain visible. **Tab actions > Session details** and
**Terminal diagnostics** open details only when requested.
Clicking terminal output follows the native CLI's mouse behavior; **Alt+click**
uses xterm's cursor-movement fallback at the live viewport. Dragging still
selects text. This is terminal navigation, not a free-form document editor:
mouse-tracking CLIs, menus and multiline input can interpret movement differently.

**Tab actions > Fullscreen tab** fills the screen with the workspace without
restarting the CLI or changing the saved panel layout. Both side panels are
completely hidden on entry. The fullscreen tab strip has **Show explorer**,
**Show prompt history**, and **Exit fullscreen** controls; panels can be opened
and closed without leaving fullscreen. Escape also exits. Exiting restores the
normal panel and split-pane layout. Dialogs and tooltips stay inside fullscreen.

Session text pastes larger than 4 KiB of UTF-8 are saved as retained text files
instead of flooding the CLI composer. Both keyboard and right-click paste use
this path. Only a short file reference is inserted; the app never submits it
automatically. While saving, terminal typing is explicitly paused, but terminal
protocol replies and the rest of the IDE remain responsive. Escape, Ctrl/Cmd+C
or **Cancel text paste** cancels the pending paste without interrupting the CLI.
Focus/session changes, reconnects and a 15-second deadline also cancel it.
Failed or uncertain delivery never falls back to the full text or replays input.

The maximum paste is 4 MiB of UTF-8; larger content is rejected with instructions
to save and reference a file yourself. Storage is bounded to 64 files / 64 MiB by
default, configurable downward in `textAttachments`. **Settings > Diagnostics >
Retained pasted text** lists retained files and offers confirmed per-file deletion.
There is no automatic expiry: deleting a file can break active, past or resumed
prompts that reference it. Refresh the list after an uncertain deletion before
retrying. The provider may still request permission to read an app-managed file;
the IDE does not bypass the CLI's file-access policy.

**Settings → Appearance → Clarity** is an opt-in surface treatment with stronger
light/dark contrast, distinct panel headers, visible selection and keyboard-focus
indicators, and separated history rows. It does not change fonts, text sizes,
line heights, or the user's density and terminal preferences.

The explorer, side-by-side editor split, and prompt history have persistent resize
handles. Drag with a mouse or touch, or focus a handle and use Left/Right
(Shift for larger steps), Home/End for limits, and Enter to reset. Double-click
also resets. Narrow editor containers stack split panes vertically.
Session tabs expose **Session details** for recorded provider/model, status,
timestamps and exit code; unknown values remain unavailable rather than guessed.
Prompt dialogs offer **Recorded turn details** for timestamps and duration.
Terminal display-scale changes refit and repaint the glyph atlas even when the
container's CSS dimensions are unchanged.

Workspace tabs use Left/Right, Home/End and Delete with roving keyboard focus;
their action menus support Up/Down, Home/End and Escape. Tab controls use shared
SVG icons. Navigation and tab-action tooltips appear on keyboard focus as well
as hover, can be dismissed with Escape, and stay within the viewport.
The command palette exposes its search, result list and active option to
screen readers.

Explorer/history sliding (220 ms), dialogs/palette transitions (200 ms) and
expandable detail sections share a restrained, reversible motion policy.
Closing content stays mounted for the transition; closed panel content is
inert, and dialogs retain focus ownership until dismissal completes.
Terminal fitting is debounced until the layout settles. Both the operating
system's reduced-motion preference and the app's Reduced/Off options disable
sliding, pulsing and chart animations; loading controls show static status text
instead. Narrow windows present the explorer and history as overlaid panels
rather than squeezing the terminal. Copying a recorded response announces
success and reports clipboard failures explicitly.
Indeterminate loading bars use a static striped treatment with reduced motion,
not a frozen percentage. Normal loading-bar movement uses transforms rather
than animating layout properties.

The shared desktop style uses compact Segoe UI/system text, flat neutral
light/dark surfaces, thin gray pane boundaries, and blue focus accents. Explorer
and Review Board use a subtle neutral selection with a leading accent indicator;
cards and controls have restrained corners without hover movement or glow.
The base type scale is 12px body/tree text, 11px metadata, 14px section headings,
and 18px page titles, with 28px controls and 24px compact actions. Dialogs retain
a soft shadow. Explicit font, size, density, radius, accent and motion preferences
still apply; session text retains its separately configurable monospace font.
Shared token aliases keep hover surfaces, muted text and control corners
consistent across views. Planner and composer controls honor the configured
corner radius, while semantic pills and avatars remain round. Default-palette
contrast, undefined CSS variables, keyboard-focus styling and motion fallbacks
have regression checks; arbitrary custom accent colors still require their
own contrast assessment.

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

The PR picker hands checkout work to a background queue and closes immediately.
Persistent **PR imports** status in the explorer shows queued, running, completed,
failed and unconfirmed results without disabling the workspace. The import
card stays at the bottom of the left panel, outside the scrolling tree,
with blue active, green successful, red failed and amber unconfirmed states.
An accented icon and count badge make ongoing imports easy to spot. The thicker
bar shows genuinely finished imports; a separate activity sweep runs only while
an import is working, including before the first completion. Failed imports
stay prominent even when other imports continue. Studio and system reduced-motion
settings replace the animation with a static activity highlight.
Closing the
picker, collapsing the tree or switching tabs does not stop checkout. Concurrent
requests for the same repository/PR join the existing backend operation.
Only queued work can be cancelled. A lost progress connection is unconfirmed,
not proof that checkout failed; **Check again** reconciles it rather than
blindly starting a duplicate checkout. Completed imports expose **Open** actions
instead of changing the user's active tab.

Bulk parent creation carries a stable operation key across retries and reloads.
Gateway/server failures remain unconfirmed; a stale reconciliation read cannot
create a second parent. Reset invalidates pending callbacks before they can
start more group creation or checkouts, but cannot undo requests already sent.

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
Saved perspective failures restore their error banner and explicit retry action
after reopening a review; merely opening it never retries a failed model request.
Related workspace tabs are grouped into **Reviews** and **Review batches**.
Expand a group to reveal its members; active and split tabs remain visible
when collapsed, and keyboard navigation reveals hidden siblings.
The tracker shows live elapsed time, final batch wall time and per-PR review
duration; individual Review Board summaries show the latest full attempt time.
The tracker can be opened from import status and updates as more imports finish;
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

Confirming feature deletion closes the dialog and queues bounded background work.
The app-wide **Feature deletions** panel shows queued/running progress, completion
or an actionable failure, even after switching views or collapsing the Explorer.
Stopping owned work is retried for up to 30 seconds; ambiguous connection failures
are not automatically retried. Check the feature before confirming another
delete after a failure. The queue lives for the current app window, not across reloads.

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
| `review-board-page/` | Mounted PR review summary, perspectives, sign-off and approval. | ✅ (within workspace) |
| `pr-review-page/` | Shared change-graph/diff/comment components; the old page is not the mounted Review Board. | shared components only |
| `planner/` | Dated tasks/backlog, imports, summaries, exports and recoverable launches. | ✅ |
| `agents/` | Catalog/configuration for the three attachable feature agents. | ✅ |
| `new-task-page/`, `bug-bash-page/` | Agent-specific workspace tabs. | ✅ (within workspace) |
| `usage/` | Top-level Workspace/IDE metasession usage view. | ✅ |
| `repo-insights/` | Repository dashboard analysis and enrichment. | ✅ (within workspace) |
| `shared-context/` | Scoped context editing/status panels, separate from skill definitions. | ✅ (within workspace) |
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
bottom status bar; the top progress/loading strip is not mounted.

Settings metasession pools retain colored session-ID chips and served counts.
The compact dashboard stays visible for every provider, even when warming is off
or unavailable. Agency's on-demand IDE sessions use the real active-session
inventory and open read-only live details; outlined slots are saved capacity,
not fabricated running sessions. Availability comes from the selected provider
and running backend, not the warm checkbox. Saving unsupported capacity retains
the target without claiming it was applied live or switching the CLI.
Click a chip for conversation details, completed-turn token charts and an
availability graph based on observed idle/busy/warming states. Availability is
not CPU, memory or inferred failure health; opening the popup starts no AI work.

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
**Manage worktrees** opens Settings → System and expands the
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
| `pending` | Pending | Context refresh is pending; session creation remains available. |
| `generating` | Analyzing | Analysis runs in the background without blocking session creation. |
| `ready` | Ready | Sessions are enabled. |
| `stale` | Refreshing | The checkout changed; context refresh runs without blocking session creation. |
| `failed` | Failed | The context viewer offers **Retry**; session creation remains available. |

Click the badge, or choose **View context** from repository actions, to open `workspace/repository-context.tsx`. The viewer shows source revision, generated/updated timestamps, lifecycle state, failure details, and the generated summary. While analysis is in flight it shows an animated "Analyzing repository" banner (`role="status"`) plus a step checklist (`collect-evidence` → `analyze` → `persist`) that marks each step running/ok/failed/skipped in real time, so it is clear what the app is doing and exactly which step failed. If a later attempt fails, the last successful summary remains visible with an explicit warning. **Refresh** starts a background generation request; while the request is being accepted the button is disabled and inline API errors are shown. A failed state changes the action label to **Retry**.

The Explorer initially fetches `GET /repos/:id/context` for every repository. It then consumes `repository.context.updated` from the shared SSE stream and keeps the newest record by `updatedAt`, so pending/analyzing/stale/ready/failed transitions appear without polling. Adding a repository triggers generation on the backend; manual refresh uses `POST /repos/:id/context/refresh`.

The new-session `+` button does not wait for optional repository analysis.
The repository page exposes analysis progress and failures. At launch the
backend attempts to refresh context within `repositoryContext.launchContextWaitMs`;
if it is not ready in time, startup continues without that optional context.
Checkout preparation and its error handling remain separate.

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

The current PR surface is **Review Board**
(`features/review-board-page/review-board-page.tsx`), opened as a workspace tab.
It combines PR/project summary, captured changed-file diffs and change graph,
evidence-grounded perspectives, findings, local reviewed marks, comments and
provider-backed approval. Legacy PR-summary/Core Analysis/0–100-score panels
are not the mounted workflow. Opening a board reads existing state; import and
startup recovery schedule automatic analysis. **Retry incomplete** resumes the
saved context, model and perspective selection with a fresh execution deadline,
keeps successful perspectives, and recomputes Final Decision. **New review**
captures fresh context after confirmation; cancelled/interrupted runs need a
new review. Preparation shows an indeterminate progress bar through checkout
refresh, graph rebuild, context collection, and authoritative board reload;
old failed-perspective counts are not shown as current review progress.
During analysis, an animated bar shows finished checks separately from active
checks; failed and skipped checks count as finished, not successful. Available
findings stream into the board, and coalesced read-only snapshots refresh saved
problem/solution explanations and diagrams every two seconds without restarting
AI or resetting active progress, timings or human decisions. Slower snapshots
cannot erase newer streamed findings or replace results from a different captured
run, commit or graph. Pending explanations show waiting text rather than asking
for a retry while the review is still running. Reduced-motion settings retain a
static activity highlight and the real finished count.
Generated fields request 1–2 short sentences and small grounded ASCII diagrams.
The overview keeps two-line problem/solution summaries and concise finding
cards. Open a finding title for its full concern, fix and evidence; its file
location opens the diff. **More tools** holds skills and decision history.
Repo/IDE provenance appears inside **Review skills**, distinguishing captured
guidance from finding citations; shared context stays separate and unavailable
references do not count as delivered guidance or executed tools.
Problem and Solution explain different behavior, not the same review inventory.
**Read explanation** and **View changes** show simple scenarios, diagrams and
before/after code verified against the captured diff, without duplicate inline
expansion controls. Summaries are not repeated there; longer legacy prose
is preserved under **Original review text**. New reviews request these separate
examples; saved reviews do not generate missing examples merely by being opened.
The Skills view groups 14 editable Cosmos DB review checklists separately.
Relevant defaults join feature-tagged instructions for Cosmos reviews; explicit
review skill selections override them. Repository skills are selected by
applicable paths, meaningful metadata or explicit references, not inventory size.
**Analyze current** never silently fetches a different commit. If the remote
head changed, **Take latest & retry** explicitly refreshes evidence, preserves
the selected review options, and starts a fresh review after preparation.
Previous results stay visible until the replacement context is ready.
Review failures, actionable criteria gaps and publication recovery
share one status panel. Per-check evidence-gap summaries are available only in
**Details**, without a duplicate overview grid. Collection notes alone do not raise an attention banner;
they remain under technical run information in **Details**.
A stale-commit error promotes **Take latest & retry**
and hides the inappropriate saved-context retry action. Technical diagnostics
and context notes remain expandable without starting AI. Problem and solution
summaries use aligned cards that stack on narrow windows; saved findings are
explicitly labelled as non-certifying while the review is incomplete.
Navigation never retries AI. Failure summaries stay concise, with
native diagnostics under **Technical details**. Missing stream results remain
visible through same-run refreshes until an authoritative result replaces them.
Engine-exit wrappers retain the preceding native diagnostic instead of hiding
the startup cause. On Windows, Agency prioritizes an installed native
`copilot.exe` in its child PATH, avoiding npm command scripts and the forwarding
VS Code shim; it does not change the user's PATH or bypass native authentication,
MCP policy, or permissions. Studio does not impose a review prompt character
budget or compact captured context to fit an IDE-selected context window.
The selected provider owns context-window handling and any resulting errors.
Collection remains bounded by file/count, command-output and timeout safety
limits; missing or oversized sources are reported rather than silently treated
as reviewed. These collection diagnostics are separate from provider failures.
Text-only Copilot/Agency turns use an empty `--available-tools` allowlist;
tool approval does not expose filtered-out tools. A wildcard `--deny-tool '*'`
is not a valid native permission rule and is not passed.
Failed/missing perspectives cannot certify Final Decision or unlock approval.
Captured skills, requirements, discussion, evidence and final synthesis are
passed without additional prompt-budget truncation. Legacy context-character
settings are ignored. Existing saved reviews retain their original evidence
and warnings; **New review** is required to collect a fresh snapshot.

PR import checks existing checkout metadata and local changes before reusing a
directory. An orphaned folder is not a Git worktree just because it exists.
When it cannot be safely reused, import preserves it and creates a separate,
review-only worktree at the fetched PR commit, without resetting existing
branches. A clean recovery checkout is reused only for the same commit and
expected branch; edited or stale checkouts remain untouched. Recovery attempts
are bounded. If the primary repository itself is missing or invalid, import
explains which local path must be restored or corrected in Settings.
See [PR reviews](features/pr-reviews.md) for evidence identity, approval and
sign-off semantics.

**Review agent** opens a dedicated, whole-review chat instead of the full
diagnostics view. In **Details**, **Ask about this perspective** opens a chat
scoped to the selected perspective. Neither action starts AI until a message
is sent. **Run information** contains timing, cost, context and diagnostics;
**Assessment evidence** contains detailed checks and rationale. Both start
collapsed, while findings, failure states, evidence gaps and sign-off controls
remain visible.

Review Board uses named actions such as **Read explanation**, **View changes** and
clickable finding titles instead of repeated information icons. Context and explanations
render safe Markdown with section headings, lists and code, within a scrollable
dialog whose actions stay accessible. Explanations lead with the concern and
fix; provenance, original observations and raw captured evidence remain available
in expandable sections. Problem/solution explanations use plain English and,
for new reviews, grounded ASCII before/after diagrams whenever the captured
code supports them. Unsupported diagrams are omitted rather than invented.
Acceptance criteria and their source evidence stay in a collapsed disclosure;
generated import counts/reference IDs are not business requirements.
**Edit acceptance criteria** and named **Inspect** actions address actual gaps
without changing approval eligibility. **Review decision** reveals the existing reasoned
disposition workflow without treating a suggested fix as verified.

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

Configuration listing, category changes and reopening the manager never start
native MCP processes or authentication flows. Last observations remain visible
without silently rechecking them. Only the app-owned bridge has an automatic
connection check; it needs no external sign-in.
The Agency category is available only while its Microsoft-internal opt-in is
enabled in Settings; direct API access follows the same eligibility check.
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
**Auth** opens an explicit check for supported, enabled connections. An observed
sign-in requirement shows red **Auth**; observed expiry shows red **Reauth**.
Unknown connections do not trigger background checks. Successful discovery is
labelled **Inventory checked; tool authorization unverified**, not authenticated,
and does not turn the authentication key green.
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
If tools arrive while a native sign-in challenge is still pending, the probe
cannot establish completed sign-in or reusable credentials. This interrupted
observation survives app restarts, disables continuation of that unsupported
flow, and directs the user to complete service sign-in in the native CLI.
An explicit tools check can observe a changed native authentication state.

IDE GitHub and Azure credentials are refreshed without interpreting helper
timeouts or unavailable keyrings as a confirmed logout. Sign-out blocks new
credential checks and publication, drains existing checks before erasing the
native credential, and discards results from older account generations.
Account status checks report unavailable storage/network helpers as errors,
preserving the last known account instead of demanding another sign-in. The
account controls expose retry and sign-out failures explicitly. A successful
status check silently refreshes the credential snapshot before acknowledging
the account, so a login completed outside the IDE reaches newly launched
sessions and supported stdio MCP servers without waiting for the warm interval.
Running processes retain their original environment and may need an explicit
restart; this does not interrupt or replay an active conversation.
These safeguards do not make a GitHub or Azure DevOps token interchangeable
with another MCP's audience, tenant, permissions or native credential cache.

**Accounts > Azure DevOps** supports multiple hosted organizations using the
same Microsoft account. **Add organization** accepts a bare organization or
an HTTPS repository URL; modern and legacy URL aliases deduplicate to one
organization entry. Existing saved sign-in settings migrate without replacing
the default organization. On first migration, Azure repositories already in
the workspace also contribute organization targets. Each entry checks native
credentials silently and sequentially, shows its own account/status/error, and
offers explicit sign-in. A failed check for one organization does not mark
another connected organization signed out or hide Microsoft-only providers.
Explicit sign-in completes Git Credential Manager's native `get` / `store`
handshake to remember the organization-to-account binding, then verifies a
silent lookup before reporting success. This lets later checks select the
cached account without reopening the browser; a save or confirmation failure
is reported rather than briefly claiming a persistent sign-in.
Saved targets and remembered display names are local UI preferences, not stored
tokens or proof of current authorization.

**Forget** removes only that entry from the list; it does not erase shared
Microsoft credentials. **Sign out saved organizations** requires confirmation
when multiple entries exist and erases their native credential targets. Native
Microsoft credentials can be shared across organizations, so this is not an
isolated per-organization logout and may affect other Azure DevOps access on the
device. Different simultaneous Microsoft identities are not selected here.

The Azure repository picker offers a **Signed-in organization** dropdown from
saved Accounts targets, silently checking each target in sequence. Selecting an
organization immediately loads its `project/repository` list. The search box
matches either project or repository names, case-insensitively; switching
organizations clears the old search and ignores late responses from the previous
target. **Refresh** rechecks saved sign-ins without launching authentication.
Unavailable checks keep last-confirmed entries with a warning instead of falsely
signing them out. Confirmed signed-out targets are excluded from the dropdown.

The repository picker also accepts an Azure DevOps organization or a full repository
URL, including legacy `organization.visualstudio.com` links. A repository URL
uses a direct project/repository lookup instead of requiring organization-wide
repository enumeration. The picker displays the parsed organization, project
and repository separately. Sign-in targets the organization and retains the
original URL for retry; browser or MCP access alone does not establish Studio's
Git Credential Manager sign-in. Permission denials are reported separately
from missing credentials, and **Load** retries even when the input is unchanged.

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

The CLI setup gate detects installation without installing anything. A fresh
profile must explicitly choose an eligible CLI, even if the suggested CLI is
already installed: **Use installed CLI** persists that choice without installing;
**Install and use** persists the choice and starts the selected installer.
Only providers returned as eligible by the API are shown. Agency requires
detected internal-network connectivity and its own authentication. Network
detection never selects or installs it. An Azure sign-in or email does not
enable it.

**Continue without waiting** is available during status checks and installation.
A status check is bounded to 15 seconds; failure or an incomplete response does
not mean a CLI is missing and does not start installation. After 30 seconds
without installer output, the gate reports stalled progress while continuing
to listen for completion.

Deferral closes the progress stream, not the installer process. If the stream
disconnects, the gate reports an unknown outcome and **Check again** rechecks
installation status without starting another possibly concurrent installer.
CLI-dependent features may remain unavailable. Recent output is limited to
200 lines, with oversized lines explicitly marked as truncated.

**Settings → CLI** centralizes the active CLI, eligible providers, installed
status, available installation commands, and schema-driven per-CLI configuration
(including executable, arguments, usage, version and sign-in commands when
supported). It uses the existing namespace draft/save/validation flow; saved
command changes may require a restart. Stop live sessions and AI work before
switching. Idle warm/probe blockers offer an explicit **Stop idle background CLI
workers** action; no work is stopped automatically and busy-work rejections
remain visible. New interactive sessions offer only the active installed CLI.

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
