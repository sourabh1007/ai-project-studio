# Contextual monitoring implementation plan

Status: contextual monitoring implemented after explicit authorization.
Advanced collection and navigation work remains tracked below; this is not a
claim that every proposed acceptance journey is complete.
Scope: app-wide, prioritizing the Review Board and preserving its minimal UI.
All monitoring areas below are in scope. Phases determine delivery order, not
whether later monitoring areas are omitted. Capability-dependent measurements
remain explicitly unavailable until a trustworthy source exists.

Related: [Review Agent plan](review-agent-plan.md).

## Implementation record

Monitoring stays in the existing owners, behind collapsed **Insights**
disclosures. There is no ninth activity-bar destination, monitoring modal
stack, added AI review pass, new chart dependency or third-party collector.
Review defaults remain Problem / Solution / Comments.

| Area | Delivered entry and behavior |
| --- | --- |
| Review attention | Review comment filters and run details: file/perspective counts and existing finding filters. Counts deduplicate groups per cell and retain each observation's actual file/perspective association, including unlocated observations. |
| Business and review skills | Review insight selector: captured requirement assessments and unique-group drill-down; captured skill/source/fingerprint by actual citing perspective. Supplied, cited and causally useful are not conflated. |
| Review timing and bulk review | Run details show known boundaries and correlated operations. The bulk tracker has an optional PR timeline whose cells reuse its existing open-review action. Parallel lane durations are not summed as elapsed wall time. |
| Usage | Usage has an optional UTC calendar/trend with exclusive date bounds; selected IDE days can show source operations. Existing repository/feature/session usage dialogs have a bounded trend over already-loaded records, not another all-history fetch. |
| Agent and automation execution | New Task and Bug Bash show attachment-scoped operations and team timelines; selecting a team row opens its existing log. Automations show occurrences and operation history. Agent catalog details have agent-scoped operation views. |
| Reliability | Operation insights offer recorded daily state counts, exact-page filtering to attempts, and separate interrupted/unknown outcomes. A page is not a population-wide failure rate. |
| Bug Bash evidence | Scenario/evidence cells open the existing scenario detail. Not run, failed, unavailable and missing evidence stay distinct. |
| MCP | Existing rankings and configured server cards expose read-only observed call/latency diagnostics. The manager entry does not open the probing/authentication tool inspector. Provider, server and scope stay separate. |
| Skills | Existing skill usage has an identity/source/repository/provider activity matrix. Invocations, prepared context and injected context remain separate; cell selection filters the existing source rows. |
| Model/route observations | Usage and contextual operation panels compare captured cohorts, separating purpose, feature, provider, route, resolved model, outcome and available context fingerprint. Sample/billing counts and timing eligibility remain visible; p95 requires 20 measured samples. |
| Resources | The existing resource panel has optional host/app CPU, RAM and backend event-loop history. It reuses the backend sampler rather than probing once per viewer. |
| Capacity and storage | Existing capacity Settings show recorded busy/idle/warming, reservations and shared queue counts. Storage history records only completed explicit scans and compares exact category/path scopes; viewing it never scans or cleans. |
| Change graph | A default-off attention overlay appears only for matching captured review/graph revisions, reusing the existing graph rather than building another graph. |

### Data, bounds and integration choices

- Usage windows are validated UTC dates, at most 366 days, with an exclusive
  upper bound. Billing and MCP sources both honor bounded rollup windows;
  retained billing still participates. Existing unwindowed behavior is kept.
- Operation metadata pages are capped at 100 in the UI and never request
  result/prompt text. Typed correlation is recorded on new review/team work;
  legacy labels are not parsed to invent run identities. Hidden-provider rows
  are filtered before pagination, including operation detail reads.
- Observed MCP reads require exact provider/server/scope and at most 31 days,
  returning at most 500 calls with a truncation marker. The UI requests seven
  days. Provider-observed latency is not merged with proxy transport totals.
- Resource history defaults to one hour / 600 points; completed storage
  history defaults to 90 scans (at most 450 category rows). Capacity defaults
  to one hour / 600 points. These bounds live in the owning config modules.
  Existing backend sampling drives both histories; opening a chart adds no
  timer or OS probe.
- Histories use bounded SQLite snapshots in the usage database group.
  Restored JSON is structurally validated. Corrupt restores and failed writes
  produce an availability explanation without failing live monitoring.
- Shared tables paginate at 60 rows and scale row count to a 600-cell target;
  trend charts draw at most 600 points and include a data table. Nulls, gaps,
  invalid times and clock rollback are not interpolated into successful work.
  Mixed-unit comparison tables do not share a heatmap intensity scale.
- Open metadata views share in-flight reads per API/window, capped at 64;
  results are not retained in a second cache. Closed disclosures unmount the
  reader; already-started shared HTTP reads are not transport-aborted, but
  obsolete owner responses are rejected. Hidden windows pause new
  insight reads while preserving controls. Visibility restoration refreshes
  the current owner. Existing SSE signals are reused, including
  `pr.review.updated`; there is no chart-specific SSE connection.
- Owner-local disclosures and existing callbacks are the implemented host
  seam. They work without reaching into shell globals, including detached
  agent views. A central typed cross-owner navigation/return service has not
  been introduced.

### Explicit remaining work and capability gaps

Precise enqueue/admission/preparation/physical-attempt boundaries, immutable
historical scenario projections and native-internal retry histories are not
newly instrumented. Current timelines show only supported run, operation and
team boundaries; settled attempts with missing end times are not shown running.
Typed MCP error outcomes and configuration-revision/origin mapping are not
available from the observed-duration source, so no reliability rate or exact
configured-revision match is claimed.

Workspace-day-to-session indexing, cross-owner aggregate-to-attachment
navigation, waiting-run-to-capacity return navigation, a command-palette
monitoring entry, and refactoring pre-existing optional streams into one
injected window host remain follow-up work. Repository/session trends use the
first 5,000 already-loaded records and explicitly exclude retained-only billing;
they do not pretend to be a complete historical rollup.

The original design and acceptance journeys below remain the target for those
extensions, not a statement that missing source capabilities have shipped.

### Validation and measured query behavior

Run build, lint and both configured coverage gates as listed at the end.
Verified: build and lint passed; 6,128 backend tests and 2,580 UI tests passed,
with 100% across each configured coverage axis. The full UI run used four
workers and an isolated session report directory to avoid shared-output
collisions; no coverage thresholds or exclusions were changed.
Focused tests cover unique-group provenance, missing timing, UTC windows,
bounded queries, provider visibility, corrupt persistence, scope races,
in-flight read limits, hidden-window refresh, and read-only MCP diagnostics.

A synthetic local Windows / Node 26 in-memory SQLite measurement used 20,000
observed calls, 100 matching feature calls and 50 warm reads of a 30-day
window. Measured p95 was 2.421 ms before the feature/window/order index and
0.239 ms with it; `EXPLAIN QUERY PLAN` removed the temporary ordering B-tree.
The selective index is included. This is a query microbenchmark, not a cold
disk, end-to-end UI, all-routes or reference-machine performance guarantee.

## Recommendation

Start with three existing surfaces, not a new dashboard:

1. **Review details:** a file/module-by-perspective attention heatmap, followed
   by an execution timeline once durable phase timing exists.
2. **Usage:** an activity/spend calendar and trend view that reuse existing
   usage rollups.
3. **App resources:** short CPU, memory and event-loop-delay trends, keeping
   host measurements separate from app/process measurements.

Then complete Automations/Agents, Business details, MCP, Skills, model comparison,
capacity, storage and the existing graph overlay. Choose a visualization because
it answers a question, not because a chart type is available.

## Architecture findings and integration decisions

The source is authoritative where older documentation or the indexed default
branch differs. The following additional boundaries were inspected before
planning placement:

| Existing boundary | Evidence | Implementation decision |
| --- | --- | --- |
| Eight activity-bar views, selected in React state | `ui/src/App.tsx`, `docs/ui-guide.md` | Keep all eight. Use Usage for cross-workspace exploration; do not introduce a ninth Monitoring view or assume an existing URL router. |
| Feature/repository/session/review/agent/bulk-tracker workspace tabs, including split panes | `ui/src/features/workspace/workspace-tabs.ts` | Bind an entry to the tab that invoked it, not to whichever tab becomes active later. Monitoring is a read-only drill-down, not another workspace tab per chart. |
| Injected agent host context with optional navigation | `ui/src/agent-host/agent-ui-contract.ts`, `features/workspace/tab-popout.tsx` | Extend host services with an optional typed monitoring callback. Implement it in both workspace and detached-window hosts; agents do not reach into shell globals. |
| Existing review details, Business details and finding dialogs | `features/review-board-page/review-board-page.tsx`, `review-overview.tsx` | Extend/consolidate these destinations. Do not layer another modal on top of them or add a new icon to every finding. |
| Scoped usage detail and resource dialogs | `components/usage-breakdown.tsx`, `features/status-bar/resource-status.tsx` | Preserve their current entry points. Add contextual views inside them instead of opening competing monitoring dialogs. |
| Workspace SSE plus optional per-consumer streams/polling | `hooks/use-usage-stream.ts`, `hooks/use-agent-usage.ts`, `backend/src/api/usage-stream.ts` | Monitoring consumes shared invalidation per window. Existing fallback subscriptions are not evidence that a shared monitoring cache/host already exists; introduce and wire that explicitly. |
| Owner services, route table and work-lifetime fencing | `backend/src/api/routes.ts`, `route-ownership.ts`, `resources-controller.ts`, `meta-operations-controller.ts` | Add read methods to owning ports/controllers, wired in `main.ts`. Route ownership is a lifecycle boundary, not a substitute for validating read scope or provider visibility. |
| UTC day-grained usage and attached SQLite databases | `usage-rollup/usage-rollup-service.ts`, `persistence/db/schema.ts` | Extend the existing rollup pipeline and schema groups. Day-only retained rows cannot be truthfully rebucketed into arbitrary local hours/timezones. |

Proposed read path:

```text
Related screen / existing metric / command palette
  -> typed owner + subject + snapshot + window
  -> window-local insights host OR existing owner's detail container
  -> shared, bounded read hook and API client
  -> owning controller -> domain read service -> injected read ports
  -> existing persisted records / bounded measurement history

Persisted owner update -> event bus -> workspace SSE invalidation
  -> coalesced refresh of visible, affected queries only
```

The shared layer owns presentation, navigation and query coordination. Review,
billing, automation, tools and resource semantics stay in their domain modules.
No all-knowing monitoring service, new agent framework or second billing store
is needed.

## What exists today

These observations refer to the current working tree, including the expanded
Review Board work. Existing charts should be extended rather than duplicated.

| Area | Inspected implementation | Reusable data / current limitation |
| --- | --- | --- |
| Usage | `ui/src/features/usage/usage-view.tsx`, `backend/src/aggregation/aggregation-contract.ts` | Period bars, provider/model tables, totals, MCP breakdown and IDE activity already exist. Richer charts need explicit date windows and consistent scope/availability semantics. |
| Feature analytics | `ui/src/features/feature-dashboard/feature-dashboard.tsx` | Recharts area, pie and bar charts already exist. Reuse this dependency and current formatters instead of adding another chart library. |
| Review Board | `backend/src/review-board/review-run-contract.ts`, `review-board-contract.ts` | Runs, selected lenses, unique observations, skill provenance, requirement assessments, decision events and run boundaries exist. The analysis contract does not expose a complete durable per-phase/per-attempt timing history. |
| IDE operations | `backend/src/meta/meta-operation-contract.ts` | Durable operation identity, provider/model, transport, lifecycle timestamps, outcome and billing availability exist. A returned operation is not proof of a correct review or a useful result. |
| Automations / agent teams | `backend/src/automation/automation-contract.ts`, `new-task/new-task-contract.ts`, `bug-bash/bug-bash-contract.ts` | Automation occurrences have phases/timestamps. Agent snapshots have roles and timing; Bug Bash has execution/evidence gaps. Current snapshots are not automatically a complete historical series of every retry. |
| Resources / capacity | `backend/src/resources/resources-contract.ts`, `resource-pressure/resource-pressure.ts`, `ui/src/features/resources/resource-panel.tsx`, `ui/src/lib/types.ts` (`MetaPoolsStatus`) | CPU/RAM/process/storage readings, event-loop delay and admission/pool counts exist. Current resource APIs expose snapshots, not a historical series. |
| MCP / skills | `backend/src/mcp-usage/mcp-usage-contract.ts`, `skill-usage/skill-usage-contract.ts`, `ui/src/components/mcp-usage-charts.tsx`, `skill-usage.tsx` | MCP rankings, call share and skill tables already exist. Tool-error outcomes and percentile-ready per-tool latency are not exposed by these rollups. Skills use a bounded recent-event window independent of the Usage period selector. |
| Network transparency | `ui/src/features/network-center/network-center.tsx` | This is a static integration/egress inventory, explicitly not a live traffic monitor. It must not be presented as measured request activity. |

## Prioritized opportunities

P1 is the first useful release; P2 deepens diagnosis; P3 completes advanced
monitoring. All rows are planned, with data dependencies preceding their chart.

| Priority | Area / question | Best visualization | Click-through / action | Data readiness |
| --- | --- | --- | --- | --- |
| P1 | Which changed areas need review attention, and from which perspectives? | File/module x perspective heatmap | Open the exact unique findings, observations, skills and captured diff | Existing run-scoped data; add bounded aggregation |
| P1 | Where and when are AI credits being consumed? | Daily calendar heatmap + spend trend; ranked bars by feature/provider/model | Open a day's underlying sessions/operations | Existing rollups; extend scoped date queries where needed |
| P1 | Is the app slow, or is the machine under pressure? | Separate CPU/RAM/event-loop time-series panels | Inspect processes and concurrent operations at the selected time | Existing measurements; add bounded sample history |
| P2 | Why is a review taking so long? | Run waterfall / Gantt lanes | Inspect preparation, queue, lens attempt or final synthesis | Run boundaries exist; precise phase/attempt history needs instrumentation |
| P2 | Which product rules remain violated or unassessed? | Categorical requirement x review/lens matrix | Open rule version, source, contradictory behavior and evidence | Existing requirement matrix; history needs explicit version alignment |
| P2 | Are agents/automations failing or getting stuck repeatedly? | Daily outcome bars + duration distribution + occurrence heatmap | Open failed, uncertain, interrupted or overdue occurrences | Existing lifecycle data; durable cross-run projections/correlation need work |
| P2 | Which tools are busy, slow or unreliable? | MCP server/tool x time heatmap; latency distribution where measured | Open tool-call metadata and availability explanation | Calls/transport totals exist; error and per-call latency coverage need instrumentation |
| P2 | Which repository/IDE skills are supplied and referenced? | Skill x perspective matrix; activity bars | Open supplied version and linked findings, without claiming causation | Review provenance and distinct skill-event kinds exist; align time-window queries |
| P2 | Is execution capacity the bottleneck? | Busy/idle/warming capacity over time + queue-depth line | Inspect admission limits, route and measured wait | Current snapshots exist; add transition/sample history and precise wait timestamps |
| P2 | Which Bug Bash scenarios actually ran and have evidence? | Scenario x outcome/evidence matrix; blocker-reason bars | Open actual output, diagnostics and reproduction instructions | Existing scenario data; retain distinct attempts for historical comparison |
| P3 | How do models/routes compare on similar work? | Cost-versus-duration scatter + median/p95 comparison bars | Open matched cohorts and raw sample counts | Operational data partly exists; reliable run/attempt correlation required |
| P3 | What is growing on disk? | Category size/growth bars and a trend line | Open measured paths or existing explicit cleanup/worktree management | Existing scans; comparable historical scans need retention |
| P3 | Which changed dependencies concentrate concerns? | Opt-in overlay on the existing change graph | Open the same findings/diff, not a separate graph universe | Reuse captured graph; bounded static relationships are not complete runtime dependency evidence |

Do not add all of these simultaneously to a single screen.

## Visualization semantics

### Review attention heatmap

- Rows: changed modules, expandable to files. Columns: selected perspectives,
  including Business. Filter by severity, skill, disposition and run.
- Each cell counts distinct unique finding groups with a captured association
  to that file and perspective. Display counts and the highest effective
  severity; do not invent a weighted "risk score."
- One group can belong to several cells. Cell counts are not additive: show a
  separately deduplicated overall total. Preserve all cross-file anchors and
  original observations through manual merge/split/undo.
- Findings without a captured file anchor belong in an explicit unlocated
  bucket; do not guess a file or distribute a PR-level concern over all files.
- Distinguish assessed/no findings, not selected/not applicable, incomplete,
  failed, and insufficient evidence. No findings is not automatically green.
- A completed lens does not prove it inspected every file. Without explicit
  per-file inspection evidence, a zero cell means "No linked findings;
  inspection not evidenced," not "This file passed."
- Explain that this shows reported review attention, not defect density,
  exhaustive code coverage or a probability that a file is unsafe.
- Selecting a cell opens the existing filtered finding list. Charts must not
  modify findings, disposition, sign-off or approval eligibility.

### Review execution timeline and capacity

- Show bounded lanes for preparation, admission wait, execution attempts,
  final synthesis and total run wall time. Keep import/graph preparation
  distinguishable from the Review Board run itself.
- Show retries as separate attempts, not an unexplained enlarged bar. Include
  failed, cancelled and interrupted work and its known billing.
- A selected lens that was never dispatched has no execution duration. Active
  spans are provisional; settled spans use recorded boundaries.
- Do not derive exact queue time from `createdAt -> startedAt` unless those
  boundaries explicitly mean enqueue and admission. Until then, label it
  "pre-start elapsed" or unavailable; startup and queuing may both contribute.
- The sum of parallel lens durations is not review elapsed time. Only claim a
  critical path if causal dependency edges and their timing are recorded.
- Separate warm/cold execution, provider/model and admission pools. Warm idle
  capacity does not imply a named-model cold request can use that capacity.
- Put current admission limits and queue counts next to a capacity chart.
  Correlation with CPU/memory is diagnostic context, not proof of causation.

### Usage, cost and model comparison

- Start with daily cells; add weekday/hour views only when trustworthy
  intraday timestamps and billing attribution support them.
- Select one metric at a time: native AIC, tokens, measured operation count or
  lifecycle elapsed time. Native provider credits and USD estimates remain
  separately labelled series, never substituted for AIC.
- Distinguish interactive work from IDE/agent overhead using existing
  attribution. Preserve retained/deleted-work buckets and unknown owners.
  Workspace and IDE scopes may overlap; never add them as independent totals.
- Existing rollup session counts are bucket-level distinct approximations.
  Summing days or model rows does not produce unique sessions for a period.
  Query a compatible distinct source or label the aggregate's actual meaning.
- Billing activity is not a developer-productivity or working-hours measure.
  Do not sum overlapping session durations into a user's elapsed workday.
- Late usage reconciliation updates an existing operation, not a second
  charge. Display partial amounts and measured/unknown sample counts.
- Model comparisons require the same task type, repository context/size band,
  selected lenses, outcome definition and route. Show sample sizes and missing
  billing/model attribution; keep unresolved `auto` separate.
- Faster completion or fewer comments does not establish model quality.
  Dismissal is not automatically a false positive; "fix verified" is a recorded
  reviewer decision, not an independent experiment. Accuracy/precision charts
  require explicit adjudication categories and a labelled evaluation set first.

### Business and Bug Bash matrices

- Business cells are categorical: supported, violated, not assessed or
  ambiguous. Use source/content-bound requirement IDs and the selected run.
  A requirement absent from a snapshot is not the same as a failed assessment.
- Never silently match changed requirement versions by similar wording.
  Compare unchanged fingerprints, or use explicit, inspectable version mapping.
- Reuse the current Business details matrix; a visual mode is an enhancement,
  not a competing source of truth or a test-coverage percentage.
- Bug Bash must distinguish an executed/evidenced pass or failure from
  `ran:false`, blocked, pending and missing evidence. Separate permission,
  environment and tooling blockers from detected product defects.
- Tool execution/agent completion alone does not mean a test scenario passed.

### MCP and skills

- Extend existing MCP rankings rather than replacing them with a decorative
  network graph. A server/tool heatmap is useful for repeated time patterns;
  simple ranked bars remain better for a small set of servers.
- Keep proxy transport duration and provider-observed call duration separate
  when their populations differ. Do not divide merged call counts into a
  proxy-only duration to invent a per-call average.
- Percentiles require recorded durations or mergeable histograms from the same
  population, not summed durations or averages of bucket percentiles.
- Errors require typed observed outcomes. Absence of completion is unknown or
  in-flight, not proof of a tool error. Preserve unknown tool/server identity.
- Skills supplied, context prepared, injected, invoked and cited are different
  signals. A supplied skill is not proof the model followed it. A linked bug
  is not proof that skill caused its discovery.
- Never divide session cost between MCP servers or skills without explicit
  source attribution. Heatmaps must preserve telemetry-window limits.

### Resources, storage and alerts

- Record bounded server-side samples at the existing sampler cadence, not one
  extra OS/process probe per chart, renderer or browser window.
- Use separate aligned panels/units for CPU, memory and event-loop delay.
  Distinguish whole-host CPU/free RAM from app/process CPU/RSS.
- Identify processes by PID plus start identity to avoid PID-reuse artifacts.
  Preserve the existing CPU normalization and RSS/shared-page caveats.
- Break lines at stale/missing samples, sleep, clock discontinuities and
  restarts. Do not interpolate a pressure spike or smooth away a measured peak.
- Storage charts use comparable, completed scans; partial bytes remain visibly
  partial. Do not rerun repository-wide scans on every chart refresh.
- Avoid storage pie/treemap percentages unless categories are proven
  non-overlapping. Logical file bytes and actual recovered disk capacity differ.
- Reuse measured resource-pressure reasons. Queue wait or a timeout cannot
  diagnose low RAM/high CPU. Optional threshold notifications need sustained
  windows, hysteresis, cooldown and visible measurement freshness.
- Clicking a chart is read-only. Pool resizing, cleanup, retries, remote
  publication and approval retain their existing explicit confirmations.

## Exact placement and progressive disclosure

### Three levels, with one canonical home per question

1. **Work surface:** keep the problem, result, comments, current status and
   actionable warnings. Reuse an existing metric/details control, or add at
   most one labelled Insights action per entity header. No new charts on the
   terminal, Planner cards or default Review Board.
2. **Contextual insight:** open one relevant visualization or table, already
   scoped to the invoking entity. A compact question selector reveals other
   relevant views, not every chart the product supports.
3. **Explore and diagnose:** a selected cell/interval opens its underlying
   findings, operations, scenarios or measurements. Explicit "Explore in Usage"
   broadens to cross-run analysis while preserving filters and a return target.

Usage and the expanded resource panel are already analytics/diagnostic
destinations, so useful charts can be primary content there. Other work surfaces
use progressive disclosure. Critical incomplete, uncertain and stale warnings
must remain visible even when Insights is closed.

### Placement matrix: local availability without duplicate dashboards

| Monitoring | Canonical home | Additional contextual entry | First view and drill-down |
| --- | --- | --- | --- |
| Spend/activity | Usage | Repository/feature overview usage action; session credit meter; agent run AIC | Open the relevant owner and period, then daily calendar/trend; a bucket opens scoped usage events/operation summaries |
| Review hotspots | Review Board run details | Existing review-comment filters/details; selected perspective or captured file | File/module x perspective heatmap for the exact run; selecting a cell applies filters to the existing unique-comments list |
| Review timing | Review Board run details | Concise run status; bulk tracker row duration | Timeline for that PR/run, or a bounded batch overview; selecting a span opens its attempt/operation, not a new review |
| Business traceability | Existing Problem/Business details | Business perspective; requirement references on a finding | Enhance the current matrix with a visual/table toggle; select a rule to inspect its captured source/version and linked findings |
| New Task execution | That attachment's New Task detail | Team progress or timing summary; related agent catalog detail | Team/attempt timeline and outcome history; choose a lane to inspect existing agent work and recorded files |
| Bug Bash evidence | That attachment's Bug Bash results | Scenario result/evidence control; related agent catalog detail | Scenario matrix with executed/evidenced/blocked states; open the current scenario evidence rather than another report surface |
| Automation reliability | Selected automation's run history | Its status/overdue warning; originating feature/session | Outcome-by-day and occurrence duration; select an occurrence to inspect the existing run record/report and explicit retry controls |
| Agent-wide reliability | Selected Agents catalog detail | Per-attachment Insights offers explicit "Compare runs" | Aggregate only attachments of that agent, with repository/provider/time filters; selecting a run navigates to its actual attachment |
| MCP activity/reliability | Usage's existing MCP section | Provider-scoped MCP server row/tool details; feature MCP usage | Open the exact provider/server/tool identity; activity heatmap, measured latency/outcomes, then payload-free call summaries |
| Skills/provenance | Usage's existing Skills section | IDE skill row where identity is mapped; feature skill usage; review skill details | Activity or skill x perspective matrix; select an entry to inspect the supplied snapshot and related findings |
| Execution capacity | Settings' existing metasession-pool detail | Waiting run's timeline; current meta-model/status detail | Queue/capacity timeline for the actual route/pool; show applicable limits and a deliberate link to configuration |
| CPU/RAM/responsiveness | Existing App resources panel | Status-bar resource control; a slow operation's "System activity" link | Short aligned host/app/process trends; select an interval/process for measurements with scope and freshness |
| Storage growth | Storage section of App resources | Settings Worktrees manager's storage link | Category/path growth using comparable scans; existing cleanup/worktree controls remain separate confirmed actions |
| Model/route comparison | Usage comparison mode | Agent detail, review model metadata, model settings link | Matched cost/duration cohorts for the originating task type; select samples to inspect operations, not automatically change models |
| Dependency concern overlay | Existing captured change graph | Selected file/module in the review heatmap | Default-off concern overlay with counts/legend; selecting a node opens the same diff/findings as today |

Cross-context links must say when the scope changes. For example, "System
activity around this run" shows machine-wide samples for a matching interval;
it must not pretend those CPU/RAM values are attributable to that review.

The Skills manager manages IDE library skills, not every repository/CLI skill.
Only link a library row to telemetry when a stable identity mapping exists.
Repository/CLI skill histories remain reachable through Usage and their frozen
review context. Likewise, a currently configured MCP server is not necessarily
identical to a historical same-named server: preserve provider/source identity
and show unknown mappings instead of guessing.

### Context binding, navigation and non-overwhelming behavior

- Each open request carries owner kind/ID, optional subject such as file/tool/
  perspective, run ID and assessment revision when relevant, selected view,
  metric, time window and a return target. Labels are display text, not identity.
- Resolve effective ownership at the backend. Do not accept conflicting owner/
  run/filter combinations or silently broaden an empty result to all work.
  Historical attribution follows its source semantics, not an unexplained
  reassignment when a session/feature moves.
- Show a short breadcrumb such as `Repository > PR > Run > Security`, plus the
  effective date window. Only applicable controls appear. Run-local matrices
  do not need a global date selector.
- A panel is bound to the invoking tab, including split-pane side. Switching
  tabs does not retarget an open panel. Explicitly changing its owner cancels
  obsolete requests and updates its breadcrumb before showing new data.
- Use a single focused drawer on wide screens and a full-screen accessible
  dialog on narrow screens. Existing owner modals host the insight in place.
  Moving from chart to finding/diff replaces the current detail body or closes
  the drawer before using the existing destination; never stack focus-trapping
  modal chains. Back restores filters, selection, scroll and unsent drafts.
- Review actions/composers and their confirmation state stay mounted in their
  existing owners. A chart click never regenerates evidence, reruns AI, posts
  comments, resizes pools, cleans disk or changes sign-off.
- A new review run does not silently replace an inspected historical snapshot.
  Display its pinned identity and offer an explicit switch to latest.
- Store lightweight preferences per owner kind/view, not raw records or prompt
  content. Do not carry a file, provider, skill or perspective filter into an
  unrelated owner; compatible metric/date preferences may carry deliberately.
- Internal navigation targets contain bounded validated IDs/filter state, not
  payloads. Deleted, inaccessible or retained-summary-only owners show a clear
  unavailable/tombstone state and preserve the return path. No new external
  deep-link scheme or general-purpose URL router is required.
- Add command-palette entries for the active owner's Insights and existing
  Usage/resources destinations. Do not invent a shortcut that conflicts with
  terminal/editor shortcuts.
- Detached session/agent windows get their own local host and shared live
  subscription, not another OS window per chart. When cross-workspace navigation
  is unavailable, show the local table/detail and an explicit Return to IDE
  path; never silently open the wrong feature in the main window.

### Common chart usability

Every chart needs a title explaining the question, units, legend, effective
scope/window, last updated time and an accessible "What does this mean?"
control. Support click/tap/keyboard, not hover-only tooltips. Provide a
table/list equivalent, non-color state labels, dark/light themes, reduced
motion, narrow layouts and reliable focus return.

Use sequential color intensity for quantities and distinct labelled categories
for outcomes. Do not reuse red/green to imply that high spending or high
activity is bad/good. Keep scales stable across a comparison and disclose any
normalization.

## Implementation work packages and ownership

These are planned changes, not claims that the named shared components exist.
Prefer extending existing files; create shared presentation only after two
working slices establish its common behavior.

| Package | Files/modules to extend | Responsibility / completion condition |
| --- | --- | --- |
| A. Typed scope and host | `ui/src/App.tsx`, `features/workspace/workspace-tabs.ts`, `agent-host/agent-ui-contract.ts`, `features/workspace/tab-popout.tsx`; small `features/monitoring/` presentation area | Typed open/return request, one window-local host, injected agent callback, split/popout-safe scope. No new activity-bar destination. |
| B. Shared read coordination | `ui/src/lib/api.ts`, `types.ts`, existing live hooks and stream reducer; monitoring-specific hooks | Request cancellation, bounded window-local query sharing, scope-safe cache keys, last-good snapshots and coalesced invalidation. Do not add a new state/query/chart dependency without demonstrated need. |
| C. Spend and model read views | `usage-rollup/`, `aggregation/`, `usage-detail/`, owning persistence readers/controllers; Usage and feature/repo/session usage controls | Bounded date/owner/provider queries; actual billing provenance, retained totals, comparisons with qualified populations; enhance the existing usage breakdown, not a parallel billing UI. |
| D. Review and graph views | `review-board/`, `pr-review/`, their read controllers; `features/review-board-page/`, bulk tracker and existing graph renderer | Attention/business/skill projections from pinned groups and context; durable attempt timing for waterfall; graph overlay and exact filtered finding/diff navigation. |
| E. Agents and automation | `meta/`, `new-task/`, `bug-bash/`, `automation/`, `agents/`, owner repos/controllers; their current UI details | Immutable attempt summaries and typed correlation; owner-specific outcomes, team timelines, scenario matrices, run-history drill-downs. Registry catalog totals do not substitute for attachment/run identity. |
| F. Tools and skills | `mcp-usage/`, `skill-usage/`, related readers/controllers, existing MCP/skill components and managers | Measured call outcomes/durations, provider/source identity, bounded time filters, skill event distinctions and captured provenance. Preserve all capability gaps. |
| G. Resources, capacity, storage | `resources/`, `resource-pressure/`, meta admission/pool ports and related controllers; resource panel, pool settings and Worktrees links | One sampler/history per backend, bounded samples/retention, applicable route capacity, comparable storage history and explicit management links. |
| H. Persistence, API and rollout | `persistence/db/schema.ts`, owning repos, `api/routes.ts`, `api/route-ownership.ts` as applicable, `main.ts`, tests/docs | Versioned additive migrations, indexes, correct domain database groups, lifecycle/read-scope integration, config registration and end-to-end gates. |

### Query and API boundary

- Extend existing owner endpoints first: `/usage/rollup`,
  `/usage/ide/rollup`, `/features/:featureId/usage/rollup`, `/meta/operations`,
  `/resources`, and the owning review/automation/tool/skill controllers.
  Existing paths are relative to the configured API base.
- Add dedicated owner-scoped summary/history GET routes where current payloads
  cannot satisfy bounded queries. Their final suffixes belong to the owning
  controller contract, not an unvalidated universal SQL/report endpoint.
- Chart DTOs carry only needed summaries, stable drill-down IDs, as-of revision,
  measurement definitions, completeness/retention and supported actions/views.
  Read scope and provider visibility apply equally to global and local entries.
- `/meta/operations` currently has identity filters and bounded pages, not an
  arbitrary chart time-range API. Add indexed date/owner summaries; do not have
  every chart exhaust every operation page. Fetch operation result text only
  through the existing explicit detail flow, never for chart aggregation.
- Existing day rollups use UTC days. Preserve their current contract, adding
  an explicitly versioned/query-defined window where necessary. A requested
  timezone cannot split historical day-only retained totals into invented
  local-hour amounts; return the effective supported time basis.
- Scope cached reads by owner, snapshot revision, window/timezone, metric,
  filters, provider visibility and schema version. Never reuse another
  repository's/attachment's similarly named subject. Bound cache memory and
  drop inaccessible/deleted owner detail while preserving allowed aggregates.

### Collection, persistence and live updates

- Source services remain authoritative. Add immutable logical-run/attempt
  summaries and typed timing transitions in their owning domains, not UI log
  parsing. Tag meta operations with generic owner/run/attempt correlation;
  transport session reuse must not merge distinct attempts.
- Review data stays with review persistence; automation occurrences stay with
  automation persistence. Usage/operation/MCP/skill records already use the
  existing usage schema group. Place new high-volume samples/projections
  deliberately through `DATABASE_GROUPS`, not extra JSON histories on features
  or a new database file by default.
- Read compatible per-call `mcp_observed_calls.duration_ms` where available
  before introducing another duration store. Expose measured sample counts;
  new typed errors/outcomes still require compatible source instrumentation.
- Keep original records/allowed retained aggregates authoritative. Any new
  projections are repairable and versioned, with bounded rebuilds. Do not
  assume crash-atomic transactions across attached WAL databases.
- Persist lifecycle transitions before invalidating charts. Reuse existing
  events such as `usage.recorded`, `meta.usage.updated`,
  `automation.updated`, and `pr.review.updated`; introduce a compact typed
  owner/revision invalidation only where existing events cannot express it.
- Wire both ends: backend event type and forwarding, UI event registration,
  parser/reducer, affected query keys and reconnect refresh. In particular,
  `pr.review.updated` is forwarded by the backend but is not currently in
  `useUsageStream`'s registered event names; do not assume it already refreshes
  every client consumer.
- Use one shared workspace SSE subscription per window for monitoring. Existing
  optional `useAgentUsage` subscriptions and the Review Board's own live hook
  need explicit host wiring/reuse, not another subscription for each chart.
  Preserve necessary dedicated active-run streams; charts consume their typed
  updates rather than duplicating them.
- Sample resources/capacity once at the configured backend cadence. Active
  resource views share a coalesced refresh; hidden views stop query work.
  Reconnection repairs from read snapshots, not replayed UI activity text.
- Reuse bounded workers for historical projections/backfills; route ownership
  and cancellation must cover queued and running work where applicable.
  Normal read-only chart opening cannot start a scan or AI task.

## Data and implementation approach

### Reuse first; instrument only genuine gaps

- Extend owning aggregation/read-side ports and controllers. Share small typed
  time-window, bucket and measurement-status contracts, not a new generic
  telemetry framework or a second billing pipeline.
- Query durable operations, automation occurrences and review snapshots rather
  than scraping UI timers, parsing prose/error strings or triggering AI work.
- Add optional typed correlation for owner/run, attachment, perspective,
  attempt and parent operation where missing. Provider sessions are reusable
  transport identities, not unique logical runs.
- Record enqueue/admission/dispatch/settlement transitions at their owning
  services for precise timing. Keep logical runs, physical attempts and
  billable operations distinct. Persist the outcome before live publication.
- Add bounded resource/capacity sample storage. A short in-memory ring buffer
  is sufficient for initial live trends if labelled with its start/reset time;
  durable longer history is a separate explicit retention decision.
- Add payload-free MCP completion outcomes/latency where providers can report
  them. Capability gaps stay unavailable; do not pretend all routes expose the
  same measurements.
- Current New Task/Bug Bash snapshots can be replaced by subsequent attempts.
  Record future immutable attempt summaries before offering historical
  success-rate/latency comparisons. Legacy rows remain partial/unknown.
- Use config/schema/defaults in owning modules and wire dependencies only in
  `backend/src/main.ts`. Keep providers behind generic ports.

### Bounded queries and truthful responses

Proposed query inputs: owner scope, bounded `[from,to)` window, timezone,
granularity, metric and supported filters. Reject unsupported combinations;
return effective window/filters and telemetry availability with the result.
Until a source supports date filtering, explicitly label its independent
window instead of pretending a shared date picker applies.

Declare each metric's time basis: source billing/event time when available,
otherwise explicitly labelled capture time; operation lifecycle time for
execution; measurement time for resource samples. Never use chart polling time
as the event timestamp. Store UTC instants and define timezone/DST bucketing
consistently. Late reconciliation must respect the source's declared time basis.

Each result needs measured/unknown/eligible counts, freshness, source coverage,
retention boundary and any truncation/partial marker. Known zero, unavailable,
not applicable, not selected and not assessed are distinct states. A zero-filled
bucket is valid only when collection coverage establishes zero.

Use bounded series/cells with top-N plus a visible remainder and paginated
detail. Proposed initial caps: 366 daily cells, 60 selected detail rows and
600 trend points per series. Treat these as configurable design defaults to
validate against realistic repositories, not limits on stored findings or
approval inputs.

Bucket at the backend, downsample peaks as well as averages where appropriate,
and reuse existing SSE invalidation with coalesced refresh. Do not create a
poller/connection for every cell. Pause hidden-view work and cancel obsolete
queries; display a labelled previous snapshot if refresh fails.

Heavy historical backfills/large projections run in bounded, cancellable
background workers. Add selective indexes and incremental aggregates only
after measuring the query, with snapshot/as-of semantics for reconciling live
updates. Define raw/aggregate retention explicitly; deleting source entities
must neither lose retained billing nor retain sensitive drill-down text by
accident. Aggregates cannot reconstruct histories that were never recorded.

### Local-first privacy

Keep monitoring local by default. Collect identities, timestamps, categories,
measured values and typed outcomes, not prompt bodies, code, requirement text,
tool arguments/results, secrets or raw network payloads. Scope queries to
authorized repositories/features; scrub paths and owner labels in explicit
exports. Exports retain unknown/partial markers and measurement definitions.

A future actual network monitor would need separate payload-free request
instrumentation and a clear permission/retention design. The existing static
Network Activity Center must remain honestly labelled. No third-party
monitoring SaaS, packet capture or extra AI analysis is needed for this plan.

## Delivery order

Each row is a vertical implementation slice with its collection/read path,
scoped UI, integration tests and documentation. These dependencies are real
prerequisites, not a requirement to finish every earlier row before doing
independent work.

| Slice | Deliverable / responsible packages | Dependencies / exit condition |
| --- | --- | --- |
| 0. Contracts and host seam | Define scope/capability/measurement DTOs, injected open/return service, source fixtures, limits and retention policies; A, B, H | No prerequisite. Every metric has an owner, unit, time basis, population, missing-state semantics and source. Decide raw/aggregate age, point/byte/cardinality caps and default sampling before shipping collectors. |
| 1A. Review attention | Run-local aggregation, attention heatmap, existing finding-filter navigation; A, B, D, H | 0. Cross-file/group totals reconcile; pinned run/revision, merge/split/undo and no-coverage states work. Default review stays Problem/Solution/Comments. |
| 1B. Usage exploration | Bounded UTC-aware calendar/trends, retained totals and scoped usage breakdown; B, C, H | 0. Repository/feature/session/IDE entries reach the correct population; date queries preserve provider visibility and late corrections. Reuse 1A presentation once its common behavior is proven. |
| 1C. Live resources | Shared sample buffer, CPU/RAM/event-loop trends in the current resource panel; B, G, H | 0. No extra OS probes per viewer; start/reset/stale gaps explicit; backend remains responsive. |
| 2A. Durable lifecycle/history | Typed run/attempt/admission transitions; retained operation projections and bounded resource/capacity history; D, E, G, H | 0. Persist before invalidate; retries, reused sessions, concurrent work, restart recovery and retention verified. Older incomplete history remains labelled rather than backfilled from guesses. |
| 2B. Review timing and capacity | Run/attempt waterfall, bulk overview, measured queue/pool history and Settings links; A, B, D, G | 1A, 2A. Exact enqueue/admission boundaries exist where displayed; parallel durations do not inflate wall time; pool links preserve the actual route. |
| 2C. Agent and automation reliability | New Task team lanes, Bug Bash scenario/evidence matrix, occurrence distributions, attached-run and catalog aggregate navigation; A, B, E | 2A. Every row points to an immutable occurrence/attempt or is marked legacy partial. Current warnings/actions remain primary; aggregate selection opens the correct attachment. |
| 2D. Business and skill views | Reuse Business details; skill/perspective provenance matrix plus bounded skill activity and library-safe links; B, D, F | 1A, 1B. Source/version mappings, supplied/invoked/cited distinctions and independent legacy telemetry windows remain visible. |
| 3A. MCP diagnostics | Bounded tool/server heatmap, measured outcome/latency read models and manager links; B, F, H | 1B. Reuse compatible stored durations; collect new typed outcomes before claiming error rates; proxy/provider populations and unavailable capabilities remain separate. |
| 3B. Model/route cohorts | Comparable cost/duration samples and aggregate comparisons in Usage; B, C, E | 1B, 2A. Cohort definitions, resolved model/route, sample sizes, billing completeness and censored attempts are inspectable. No model-quality ranking without separate adjudicated evidence. |
| 3C. Storage history | Record completed existing scans; category growth and measured-path drill-down; B, G, H | 1C. Same-category comparable snapshots, bounded retention and partial-scan gaps verified. Opening the view never runs a scan or cleanup. |
| 3D. Change-graph overlay | Opt-in attention layer and finding/diff navigation on the existing graph; D | 1A. Only matching captured file/revision identities map; unlocated findings and truncated/static graph limits stay explicit. Graph absence does not trigger a scan. |

Collection in 2A and 3A can start alongside phase 1 after the measurement
contract, so historical data accumulates before the later views ship.
The first release is 1A-1C; completion of this plan includes every later slice,
not just the first release. Unsupported provider-specific telemetry is a
visible capability gap, not a reason to block all compatible views.

Build representative slices before extracting reusable chart wrappers. Reuse
Recharts for time-series/bars and small accessible HTML/SVG matrices for
heatmaps; no new visualization dependency is needed initially. A matrix/table
is enough where a chart adds no diagnostic value. Roll out each slice at its
canonical home and contextual entries, never by filling a global dashboard.

### Integration and rollout controls

- Each slice registers owning config/defaults in `main.ts`, adds compatible
  migrations/indexes where needed, and supplies explicit capability/partial
  states before exposing its navigation. No arbitrary universal report API.
- Monitor collection/query overhead with existing process/event-loop measures.
  Define budget fixtures for large reviews, long histories and multiple open
  windows. A disabled or failing monitoring collector must not block reviews,
  billing ingestion, terminal work or automation completion.
- Roll back a slice by disabling its view/collection through owning config,
  retaining backward-compatible schema/data and existing table/details flows.
  Do not couple domain success to successful chart projection writes.
- Keep known totals and meaningful explanations available during empty-history
  warm-up, provider capability gaps or projection lag. Do not rank cohorts or
  turn cells green merely because collection just started.

## Verification and acceptance

- Heatmap totals reconcile to the exact filtered unique finding groups;
  cross-file/multi-perspective membership never inflates the overall total.
  Test merges, splits, undo, disposition/severity changes and stale runs.
- Missing/failed/skipped/insufficient review and Business assessments never look
  like clean coverage. Viewing/filtering charts cannot change sign-off or
  approval inputs.
- Test duplicate events, retries, concurrent attempts, out-of-order completion,
  late billing, reusable provider sessions, uncertain physical termination and
  backend restart without double-counting or inventing completion.
- Check DST/timezone boundaries, inclusive/exclusive windows, leap days,
  missing timestamps, clock rollback and short/empty/single-point series.
- Verify retained/deleted work and provider-specific unavailable billing.
  Quantiles use compatible duration samples; every rate shows numerator,
  denominator, unknown outcomes and time window. Suppress unsupported
  small-sample comparisons rather than ranking them.
- Verify current-row snapshots cannot masquerade as complete historical
  attempts. Resource curves preserve gaps and sampling timestamps, including
  process identity changes and desktop sleep.
- Test slow/offline refresh, permission denial, limited retention, partial
  scans, high-cardinality repositories and cancellation. Keep unrelated API
  requests responsive under concurrent chart queries.
- Initial performance target: warm local queries for a bounded 30-day window
  complete within 500 ms p95 on a documented reference machine/dataset.
  Benchmark before committing the target; report dataset size and cold/cache
  behavior. Resource probes must remain at their configured cadence, with no
  additional probe per open chart/window.
- Keyboard, screen-reader, touch, theme and narrow-screen tests cover both
  chart navigation and the equivalent table; selecting details preserves
  drafts and context.
- Exercise the contextual journeys below in integration/component tests,
  including the main window, split panes and detached session/agent hosts.
- Add focused backend and UI tests for implemented slices, then run build,
  lint and both configured coverage gates. Preserve the backend's 100% gate.

### Contextual UX acceptance journeys

| Journey | Required behavior |
| --- | --- |
| Review while drafting a comment | Open run Insights, choose Business/file, inspect its exact groups, then return; draft, selection, scroll and approval inputs are unchanged |
| Repository -> spend -> session | Existing usage action inherits repository and date; selected bucket lists only its source-compatible rows; deleted-work totals stay visible without invented session links |
| Waiting PR -> capacity | Show its actual route and known wait boundaries; System activity is explicitly machine-wide, not falsely attributed review CPU |
| Bulk tracker -> one PR -> newer run arrives | Inspect the chosen PR/run; the view remains pinned and offers latest explicitly, without blending runs or changing tracker selection |
| Attached New Task/Bug Bash -> compare -> back | Aggregate uses that agent and chosen scope; selecting an occurrence opens the correct attachment/attempt; back restores the original result context |
| MCP/Skills manager -> telemetry | Identity matches provider/source/snapshot, or reports unmapped/unavailable; viewing history never probes servers, reauthenticates, edits skills or opens unrelated same-named entities |
| Split pane / detached agent window | Entry uses its invoking owner, not the other pane or main window; unsupported navigation has a local read-only fallback; no per-chart workspace SSE/probe duplication |
| Run changes, owner deleted, or request races | Reject late results for the previous owner/revision; retain the explicit unavailable/last-good state and focus/back path instead of broadening the query |
| Resources -> storage -> Worktrees | Reuse resource details and explicit existing management navigation; no automatic scan, cleanup or hidden configuration change |
| Default screens after rollout | Review remains Problem/Solution/Comments, terminal and Planner stay uncluttered, and each relevant owner has one discoverable path to its insights |

Implementation gates for each completed slice:

```text
npm run build
npm run lint
npm run test:coverage --workspace backend
npm run test:coverage --workspace ui
```

The implementation record above distinguishes delivered runtime behavior from
the remaining design. Validate runtime changes with these gates and inspect
documentation changes for consistency and whitespace.
