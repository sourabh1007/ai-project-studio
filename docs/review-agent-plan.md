# Review agent enhancement plan

Status: planning only. Do not implement until explicitly requested.

## Investigation findings

The following inspected contracts shape this plan. These are implementation
constraints, not a claim that the proposed changes already exist.

| Current behavior | Planning consequence |
| --- | --- |
| Common perspective prompt variables contain descriptions, metadata, and paths; the problem/solution lens additionally gets a digest (`review-board-prompt.ts`, `review-board-service.ts`). | Supply captured code evidence to every lens; more prompts alone will not make the review deeper. |
| Saved analyses and in-flight sharing use head/graph/perspective identity (`review-board-service.ts`). | Add run identity, prompt/context fingerprints, and explicit rerun semantics; otherwise a model or skill change can reuse old output. |
| Warm routing currently accepts only the default `auto` model and has tool/attachment restrictions (`meta/warm-route-policy.ts`). | Named models may require cold execution and different concurrency; never promise a warm model override. |
| Studio skill attachments currently have feature/session scopes, not a repository attachment scope (`skills-contract.ts`, `skills-service.ts`). | Resolve repository-file guidance through an explicit read port; do not pretend repository-scoped Studio attachments already exist or expand the global skills model unnecessarily. |
| Review queue persistence currently records a pending flag; execution/progress also depends on the renderer run store (`review-board-queue.ts`, UI `review-board-run-store.ts`). | Persist run options and attempt state on the backend, reconnect by run ID, and define recovery without duplicate execution. |
| Approval re-discovers perspectives rather than reading a saved selected-perspective manifest (`pr-approval-service.ts`). | Make one immutable run manifest authoritative for execution, completion, sign-off, and approval. |
| Legacy check normalization defaults an unknown check status to pass, and finding IDs use array position (`review-board-parser.ts`). | New response contracts must reject invalid outcomes; use durable observation/group identity rather than array indexes. |
| Posting a finding currently invokes local resolution handling (`finding-comment-dialog.tsx`). | Separate posted/discussed from fixed/dismissed so a remote comment cannot imply remediation. |
| Finding caps can discard later observations (`capPerspectiveFindings`); prior-discussion prompts ask the model to omit existing concerns (`review-board-prompt.ts`). | Preserve validated observations within storage bounds, disclose overflow, and link existing concerns instead of hiding them. |

## Goal and scope

Extend the existing Review Board to review PRs using repository skills,
IDE-configured perspectives, business requirements, and concrete code evidence.
Provide per-review model selection and a consolidated view of unique findings.
Preserve existing provider-neutral execution, usage attribution, explicit remote
actions, and evidence-pinned approval checks.

"Repository skills" includes applicable repository instruction/skill files and
explicitly selected Studio instruction skills. "Unique comments" means grouped
review findings across perspectives, linked to matching existing PR threads.
It does not mean deleting, rewriting, or automatically posting remote comments.

## User experience

1. Import a PR (or bulk PRs), choose automatic review or import-only, and inspect
   the review setup: model, perspectives, selected skills, available business
   requirements, and missing context.
2. Preview the actual context/skill mapping each perspective will receive, not
   just a generic prompt template. Start using a saved immutable setup.
3. Follow preparation, queued/running lenses, validation/aggregation, and final
   synthesis. Timings distinguish queue, execution, and end-to-end wall time.
4. Inspect Perspectives, Unique findings, Skills used, and Business requirements.
   Navigate from a skill to its checks/findings, or from a bug to its contributing
   lenses, rules, scenario, and captured code.
5. Explicitly post selected comments, dismiss with a reason, verify a fix, sign
   off, or approve using current run identity. None of these actions is implied
   by another.

## 1. Immutable review context

Prepare one bounded context snapshot before running the selected perspectives:

- Captured diffs, changed symbols, relevant callers/contracts, and related tests.
- Applicable root and nested repository guidance and relevant repository skills.
- Selected Studio instruction skills and existing workspace/repository/feature
  shared context.
- IDE-configured perspective prompts and existing PR discussions.
- Available business context: PR intent, linked issue/work-item requirements,
  acceptance criteria, feature descriptions, and explicitly selected product
  documentation.

Give every perspective relevant code evidence, not just filenames and additional
instructions. The inspected common prompt variables currently supply PR
descriptions, project metadata, and changed-file names; the problem/solution
perspective additionally receives a solution digest.

Show included context, source revisions, missing evidence, exclusions, and
truncation. Do not assume linked business material is available: retrieve it
through existing authorized ports where supported, otherwise report the gap.

Repository files and remote text are untrusted. They must not override safety,
execute commands, suppress findings, or silently change review policy. Flag
instruction-file changes in the PR and distinguish proposed guidance from the
trusted review baseline.

### Evidence selection and trust rules

- Pin head, target/base commit, merge base, graph/analyzer version, and captured
  source blobs. Do not read a dirty worktree or another PR's checkout as evidence.
  Graphs are bounded reference evidence, not proof of complete resolved callers.
- Load applicable guidance from the pinned target baseline. Display head-side
  additions/edits/deletions as proposed policy changes; applying them requires
  explicit reviewer selection in a new run, never silent self-approval.
- Define supported skill/instruction locations in module config. Discover from
  tracked files, apply root and nearest applicable nested/path-scoped guidance,
  preserve meaningful path case, and reject traversal/out-of-root symlink access.
  Skip binary/generated/vendor content by default with recorded exceptions.
- Treat overlapping rules as source-attributed constraints, not arbitrary
  last-write-wins text. Flag conflicting business/architecture guidance for
  clarification; repository text cannot outrank host safety or user review policy.
- Select relevant instruction skills only. Exclude task-plan/removal instructions
  and do not execute skill scripts, install dependencies, or follow arbitrary
  URLs from skill text.
- Build small per-perspective evidence packs with a shared context index.
  Reserve space for diffs, rule references, requirements, discussion, and output
  under the chosen model's supported context limit. Character limits are
  additional safety bounds, not a guarantee of token fit.
- For large PRs, use bounded file/module chunks plus an explicit cross-module
  interaction pass. Record which hunks/files/rules were assessed, omitted, or
  unavailable. Summaries must retain links to captured originals and cannot
  establish precise line coordinates or claim full review coverage.
- Use existing authorized integrations for linked requirements. No arbitrary
  network fetches; denied/private material stays unavailable. Do not expose
  secrets or unrestricted context snapshots in logs, exports, or posted comments.

## 2. Skills, perspectives, and bug attribution

Add a "Repository skills used" section to each review. For every skill show:

- Name, source path or Studio skill ID, scope, revision/content fingerprint.
- Whether it was discovered, selected, included in a perspective's prompt,
  explicitly cited in analysis, excluded, or unavailable, with the reason.
- Perspectives that received the skill and the applicable rule/check references.
- Bugs/findings linked to that skill, including severity, evidence, and status.

Present the relationship in both directions:

| Repository skill | Perspective | Bug/finding |
| --- | --- | --- |
| Example: persistence conventions | Data integrity | Example: retry can insert a duplicate record |
| Example: product entitlement rules | Business | Example: trial users lose an allowed workflow |

These are illustrative rows, not findings about the current repository.

Each finding shows its contributing perspectives and supporting skill/rule
references, with navigation back to the exact snapshot text. A skill may
contribute to several findings; a finding may cite several skills/perspectives.

Do not claim a skill "found" a bug merely because its text was included.
Validate reported skill references against the supplied snapshot, distinguish
"included as context" from "cited in this finding," and retain findings with
no skill attribution. Zero findings is not proof every rule was verified.
Show explicit check outcomes or "not assessed" rather than inventing compliance.

Assign snapshot-local IDs to skill rules, requirements, and evidence fragments.
Validate citations against the actual perspective input, not just against all
repository files. A syntactically valid reference shows provenance, not proof
that the model interpreted the rule correctly; the reviewer can inspect it.
Preserve source identity even when identical skill text is loaded from several
places, and avoid sending the same text repeatedly.

Show separate counts for selected skills, delivered skills, cited rules,
completed checks, and unique bugs. Do not label injected context as executed or
verified skill coverage.

## 3. Broader, relevant engineering perspectives

Reuse the existing perspective definitions and improve selection beyond a
single dominant project type. Offer recommended perspectives with reasons and
allow manual selection.

| Change signals | Review emphasis |
| --- | --- |
| Async work and state changes | Races, cancellation, retries, idempotency |
| Persistence and schemas | Integrity, migrations, compatibility, rollback |
| UI changes | Loading/error states, accessibility, interaction regressions |
| APIs and integrations | Authorization, validation, contracts, downstream consumers |
| Processes and background jobs | Resource bounds, lifecycle, responsiveness |
| Repository skills | Project-specific architecture and engineering rules |

Each lens receives relevant evidence and applicable skills rather than every
available document. Run Final Decision after all selected perspectives settle,
using their actual results, unresolved findings, and coverage gaps. Incomplete
or failed perspectives must not become an approval through synthesis.

Use a saved manifest of required and optional perspectives. Keep existing core
checks required by default; optional lenses can be added/removed before the run.
Show exclusions and their effect on coverage. Business is selected by default
for behavior changes; excluding it produces an explicitly code-only review.
Do not let a client silently remove required checks to enable approval.

Separate execution state (queued/running/completed/failed/cancelled/interrupted)
from assessment (concerns/no concerns found/insufficient evidence/not applicable).
Zero findings does not mean complete evidence or a verified pass. "Not
applicable" requires a justified scope reason; missing context is not that reason.

First-pass lenses remain independent to reduce anchoring. After they finish,
aggregate validated findings, surface conflicting assessments, and produce final
synthesis. A lens retry invalidates its dependent aggregation/synthesis and human
sign-off, not unrelated observations from the same immutable run inputs.
Synthesis cannot dismiss a supported blocking finding by majority vote. New
concerns proposed only by synthesis require evidence validation before counting
as findings.

Require actionable findings to explain trigger/scenario, changed behavior,
cause-to-impact reasoning, evidence, and a concrete fix or verification. Separate
observed regressions from uncertain concerns and optional improvements. Validate
paths, IDs, captured coordinates, and schema deterministically before grouping.
A focused same-model challenge of high-impact or contradictory candidates may
be enabled within an explicit budget, but is not another full review or a
correctness guarantee. Preserve the candidate and challenge result for inspection.
Do not run repository commands/tests as part of this default read-only review;
suggested checks and externally supplied execution results are clearly distinct.

## 4. Explicit Business perspective

Add a selectable Business perspective alongside engineering/code review,
recommended by default for behavior-changing PRs. Keep it distinct from the
existing Problem/Solution lens:

- Problem/Solution checks whether the implementation addresses the stated
  problem.
- Business checks whether resulting behavior satisfies documented product rules,
  acceptance criteria, user journeys, and customer/operational outcomes.

Review applicable scenarios such as:

- Happy paths and exceptional user journeys; missing acceptance criteria.
- Roles, permissions, entitlements, plans, limits, and eligibility.
- Business calculations, state transitions, workflow ordering, and invariants.
- Existing customer behavior, compatibility, and unintended product regressions.
- Data-loss or operational consequences, and business-rule test coverage.

Only assess rules supported by supplied evidence; these are possible review
directions, not assumptions that every project has billing or entitlements.

Business findings must identify the requirement/rule, the contradictory changed
behavior, affected user/scenario, code evidence, impact, and suggested fix or
verification. Link relevant business/repository skills using the same attribution
model as engineering findings.

When requirements are missing or ambiguous, report "insufficient business
context" and the specific unanswered questions. Do not invent business policy,
raise an unsupported bug, or mark the business review passed.

Expose business focus/format prompts in the owning agent's IDE settings, using
the same configuration and machine-readable validation patterns as other lenses.
Include business results and uncertainty in Final Decision without changing
explicit human sign-off or remote approval semantics.

Present a requirement-to-behavior matrix:

| Requirement/rule | Source | Changed behavior and evidence | Assessment |
| --- | --- | --- | --- |
| Snapshot requirement ID | Issue/acceptance criterion/document revision | Changed path/symbol and scenario | Supported / violated / not assessed / ambiguous |

This is a qualitative traceability view, not an AI-generated coverage percentage
or a claim that tests ran. Link actual test evidence separately from suggested
test scenarios. Distinguish a missing product decision, an observed functional
defect, and an optional product improvement.

Use explicit source precedence agreed in the run setup (reviewer-selected
requirements before inferred PR intent). Surface conflicting issue text, old
documentation, and changed requirements; do not resolve policy disagreements by
guessing. Limit this PR's scope: unchanged pre-existing behavior is context unless
the change introduces or exposes a demonstrable regression.

## 5. Per-review model selection

Before starting, offer "Use IDE default" or an available model from the active,
execution-capable provider's catalog.

- Resolve and freeze the run's selection without changing global IDE settings.
- Apply it to all selected perspectives, retries, and final synthesis.
- Record requested and actual provider/model where the provider reports them.
- An explicit unavailable model produces an actionable error, not silent fallback.
- Respect existing provider readiness, isolation, and execution-policy checks.

Thread the choice through the existing MetaRequest provider/model overrides and
verify compatible warm/cold routing. Show model provenance in review results.

The current warm policy serves only `auto`; named model selections must use a
supported cold route unless a separately verified provider capability can honor
them warm. Freeze the chosen provider and requested model at run creation;
`auto` is explicitly provider-selected, so record actual model per attempt when
available and never claim all auto attempts used one concrete model.

Recheck account eligibility before dispatch, and pause/fail explicitly if the
active provider changes or the model becomes unavailable. Catalog metadata can
be stale; do not silently reroute a queued run. A model change requires a new run,
not mixing new results into an old one.

Keep reviews read-only. `toolsOptional` is not a security boundary: providers
unable to enforce the required tool/context isolation must use a compatible
route or report unsupported execution. Verify warm session reset/isolation and
provider-native implicit instructions so another PR's context cannot leak into
this review; unknown provider context limitations must be disclosed.

Bound concurrency by actual execution capacity and shared process admission, not
the number of warm sessions when the selected model runs cold. Bound attempts and
total elapsed time across retries/chunks, handle rate limits without retry storms,
and allow cancellation between phases. Show the planned work and vendor pricing
hints when available, not invented credit estimates. Preserve measured AIC for
all charged attempts, including failed or cancelled ones.

Because imported PRs currently start reviewing automatically, expose settings in
single and bulk PR import as well as manual review controls. Preserve automatic
review using defaults; snapshot the chosen options for each queued run.

Offer an explicit "Import only; review later" option so context/model choices can
be inspected before spending on AI. Bulk runs inherit one saved setup with
per-PR snapshots and applicability; one PR's missing requirements or failure
does not stop the rest.

## 6. All unique findings/comments view

Keep perspective navigation and add a consolidated view:

- One row per distinct issue, ordered by severity.
- File/location, concern, impact, suggested fix, skill/rule references,
  contributing perspectives, and model provenance.
- Filters for severity, perspective (including Business), skill, file, and local
  disposition.
- Expandable original observations and a "Unique findings / All observations"
  toggle.

Deduplicate conservatively using affected code, underlying cause, and correction.
The same file/line or similar title is not enough. Keep uncertain matches
separate, preserve original observations and evidence, and retain every
contributing skill/perspective reference when grouping.

Use deterministic exact grouping first. For less certain matches, show "possible
duplicate" candidates with reasons; do not silently ask another model to merge
everything. Keep semantic auto-merging out of the first release. Allow explicit
merge/split with reversible, recorded decisions. A cross-file root cause may
have several anchors, while different defects at one line must remain separate.
Use durable observation IDs plus persisted group membership; never key resolution
to the parser's array position or a title that changes on rerun.

Keep severity and confidence separate. A group retains the highest supported
severity and all conflicting assessments until a reviewer records a justified
change; several lenses agreeing is not independent proof of correctness.
Filtering or pagination changes presentation, not totals or approval inputs.
Keep validated raw observations within explicit storage limits, prioritize
high-severity results, and disclose output/storage overflow. A display cap must
not silently discard blockers or certify comprehensive coverage.

Match existing PR threads and display "Already discussed" with links and remote
status. A resolved thread is context, not proof the current code fixes the issue.
Missing thread access must be visible rather than implying no prior discussion.

Track the frozen discussion snapshot separately from live thread status:
refreshing a thread badge does not rerun or rewrite a review. A user requesting
analysis using new discussion creates a new context revision. Existing thread
matches annotate findings instead of removing still-supported concerns.

Reuse the existing explicit comment composer. Do not automatically publish,
resolve remote threads, or treat a posted comment as a code fix. Deduplication
must not hide blocking findings or make incomplete reviews approval-eligible.

Keep local disposition (open/dismissed/fix verified), publication (not posted/
posted/uncertain), and remote thread status separate. Require a reason for
dismissal or manual severity changes. A rerun may suggest a fix is present, but
does not silently inherit "fixed" from older code or from comment publication.

Validate every inline anchor against the captured path, hunk, side, and reviewed
commit, including renames and deletions. Current posting supports right-side
anchors: left-only or unmapped findings use an explicitly confirmed PR-level
comment, not a guessed new line. Apply stale-head checks to PR-level comments too.
Use a durable publication operation key and reconcile provider state after an
ambiguous timeout; if provider idempotency is unavailable, surface uncertainty
and require checking the PR before retry. Never promise exactly-once remote
posting without provider support.

## 7. Persistence, identity, and approval safety

Extend review identity beyond PR head and graph revision to cover:

- Selected perspectives, including Business when selected.
- Target/base/merge-base commits and evidence collector/analyzer revisions.
- Context, requirements, and skills content fingerprints.
- Perspective prompt/config revisions.
- Resolved review model selection.

Persist snapshots, validated skill/finding provenance, raw observations,
canonical groups, analysis outcomes, and model metadata. Freeze active run
inputs. Changed settings or context create a new run instead of reusing
incompatible cached results. Keep earlier results distinguishable as history.
Do not backfill invented provenance onto older reviews.

Give the run an immutable ID, manifest revision/fingerprint, per-perspective
attempt IDs, and versioned aggregation/synthesis results. Include run/attempt
identity in cache keys, pending-request sharing, events, writes, publication, and
human sign-off. Explicit rerun starts a fresh attempt rather than returning a
previous saved analysis. A late old attempt cannot overwrite the active attempt.

Persist manifest and queue intent before returning a successful start. Store
per-perspective results incrementally with atomic/version-checked writes so
concurrent completion cannot lose another lens's findings. Duplicate starts for
the same intent attach to one run; a requested fresh run is distinct.

Backend state is authoritative. Renderer disconnect/tab closure must not decide
whether durable work succeeded; reconnect queries by run ID and restores recorded
progress. Explicit cancellation is different from disconnect. After backend
restart, reconcile known attempts; mark uncertain work interrupted and avoid
blind retries that could duplicate provider work or billing.

Persisted run scheduling must integrate existing admission/cancellation patterns,
not introduce an unrelated workflow engine. Report queue/running/settled states
and validate the single-perspective and streamed whole-board APIs identically.
The manually mounted streaming handler in `main.ts` also needs the new request
validation and manifest propagation, not only the ordinary controller routes.

Approval remains pinned to the exact reviewed evidence and required completed
analyses. Business context gaps, analysis failures, and explicit skips remain
visible and follow an explicit eligibility policy rather than silently passing.

Read required perspectives from the saved manifest, not fresh project discovery.
Extend UI sign-off and backend approval confirmation to include run ID and
assessment revision as well as evidence/head identity. Recheck after asynchronous
provider-head reads and immediately before the remote action. A head/base change,
active replacement run, or changed attempt/assessment invalidates confirmation.
Do not imply atomic remote approval if the provider cannot pin its action to the
reviewed head; document and surface provider-specific limitations.

Proposed default: selected required perspectives with failed/interrupted or
insufficient-evidence outcomes cannot certify complete review; justified
not-applicable outcomes remain visible. Missing business context in a selected
Business review is incomplete, not approved. Excluding optional Business before
a new run labels that run code-only. Preserve explicit human approval and existing
finding-severity policy; do not silently introduce an automatic merge/approval
action or a new severity-based prohibition.

Version persisted shapes and migrate additively. Older reviews stay readable but
cannot manufacture missing skills/model/manifest certification. Bound snapshot,
attempt, and history retention; clean run-owned artifacts on deletion/cancellation
without deleting another PR's shared worktree/context. Keep historical references
usable when a skill is renamed or deleted.

## 8. Implementation boundaries

| Area | Expected touchpoints |
| --- | --- |
| Context, perspectives, attribution, aggregation | backend/src/review-board/ |
| Skill composition | backend/src/skills/ and repository-context ports |
| Business context | Existing feature, repository, issue/work-item read ports |
| Model execution | Existing meta runner, catalog, and routing |
| APIs and streaming | Review Board controller and streaming handler |
| Persistence and eligibility | PR-review contracts/repository and approval service |
| Review controls and provenance views | ui/src/features/review-board-page/ |
| Automatic/bulk review configuration | PR import controls and review run store |
| Sign-off identity and disposition | ui/src/lib/review-signoff.ts and finding/comment state |
| Dependency wiring | backend/src/main.ts |

Keep domain logic pure behind injected ports. Add module-owned config through
the existing namespace/schema/defaults mechanism. Bound/cancel discovery and
aggregation; expensive repository analysis belongs in background workers, not
HTTP handlers. Preserve measured usage attribution. No new MCP server is needed.

## 9. Delivery sequence

1. Context snapshots, skill provenance contracts, model selection, and cache/run
   identity; durable start/recovery and authoritative manifests.
2. Improved perspective selection and Business review, skill-to-finding
   attribution, strict assessment validation, and dependent final synthesis.
3. Unique-findings aggregation, existing-thread matching, and skill/perspective/
   finding navigation in the UI; separate disposition/publication and consistent
   sign-off/approval identity.

Each increment includes compatibility tests and read-only previews before
enabling changed automatic-review behavior. Keep per-perspective model choices,
multi-model voting, executable skills, autonomous fixes, and a new MCP/workflow
platform out of this scope.

## 10. Acceptance and validation

- Every perspective receives relevant captured code evidence within explicit
  budgets; missing evidence remains visible.
- Root/nested skill scoping, selection, trust boundaries, modified instructions,
  exclusions, and truncation behave predictably.
- Reviewers can see which repository skills were included for each perspective
  and which specific rules support each bug, without invented attribution.
- Business review detects evidence-backed requirement/behavior mismatches and
  reports insufficient context without claiming success.
- Model choice reaches warm/cold execution, retries, and synthesis without
  altering IDE defaults or bypassing provider restrictions.
- Context, skill, requirement, prompt, model, or perspective changes invalidate
  incompatible reuse; old reviews remain readable.
- Duplicate issues across lenses retain all provenance; distinct issues on the
  same line remain separate. Existing discussions are linked, not overwritten.
- Single/bulk automatic review respects saved options; final synthesis waits
  for perspective outcomes; stale-head posting and approval remain guarded.
- Concurrent review preparation does not block unrelated APIs; cancellation,
  queue limits, and partial/failure states are tested.

### Edge-case test matrix

| Case | Expected behavior |
| --- | --- |
| Skill missing, empty, renamed, deleted, duplicated, or changed in PR | Stable snapshot provenance; exclusions/conflicts visible; proposed guidance never silently replaces baseline. |
| Nested skills contradict root or linked business rules | Show scope and conflict; no arbitrary override or unsupported policy verdict. |
| No business requirements, inaccessible issue, or ambiguous acceptance criteria | Continue useful code analysis; mark Business insufficient/ambiguous rather than clean. |
| Only tests/docs/config change; mixed-language monorepo | Select lenses from changed behavior/signals, justify applicability, and allow explicit additions without relying on one project label. |
| Dirty worktree, force push, target branch movement, rename/deletion | Review pinned blobs; refresh creates new identity; stale actions fail; no fabricated anchors. |
| Binary/submodule/generated files, huge diff, unsupported parser | State unavailable/partial coverage and limits; no implied full pass or invented graph edges. |
| Malformed enum, unknown rule/evidence ID, contradictory skip/findings | Reject new machine output with bounded retry; never coerce unknown statuses to pass or silently discard findings into a clean result. |
| Missing test execution evidence | Describe inspection/suggested verification, never claim a test ran or a requirement is proven. |
| Same root cause across lenses/files; different defects at same line | Group only supported duplicates, preserve all anchors/provenance, allow reversible split/merge. |
| Duplicate grouping would hide stronger severity or exceed display limit | Retain stronger supported concern and disclose overflow independent of visible count. |
| Existing/resolved thread still describes an unfixed issue | Link the thread; retain the concern; no automatic fix inference or duplicate post. |
| Model removed, quota exhausted, named model on warm pool, provider switch | Explicit paused/failed/unsupported state; correct cold route/admission; no silent model change. |
| Concurrent start/retry/reset, cancelled run completes late | One owner per intent/attempt; reject obsolete writes/events; new rerun does real work. |
| Browser disconnect or backend restart during analysis | Restore backend results; reconcile interrupted work; no unbounded automatic retries or duplicated billing. |
| Lens retry after final synthesis or human sign-off | Invalidate dependent verdict/sign-off; retain unaffected evidence and observations. |
| Comment POST times out after provider accepted it | Reconcile/mark uncertain; do not blindly post again or mark fixed. |
| Approval confirmed while run, head, base, or assessment changes | Revalidate identity and reject stale confirmation; honor provider pinning limits. |
| Skill text/requirements contain command or instruction injection | Treat as untrusted evidence; no tool execution or policy bypass; preserve access restrictions. |
| Legacy review without manifest/provenance | Readable historical view; explicit new review required for new certification. |

### Quality evaluation before rollout

Create a small versioned, sanitized fixture set of representative PR changes:
known functional defects, business-rule violations, clean changes, duplicate
findings, and incomplete-context cases. Use deterministic fakes for contracts
and UI tests; optional live-provider evaluations are explicit, bounded, and not
part of the mandatory unit coverage gate.

Compare against the current review behavior on actionable precision, missed known
issues, false business claims, evidence/skill attribution correctness, duplicate
grouping mistakes, disclosed coverage gaps, elapsed time, and measured usage.
Do not use number of comments or agreement across lenses as the quality metric.
Set rollout acceptance thresholds before implementation and verify that deeper
review improves useful signal without hiding failures or multiplying cost.

During implementation, add focused tests to the existing suites, then run:

```text
npm run build
npm run lint
npm run test:coverage --workspace backend
npm run test:coverage --workspace ui
```

Maintain the backend's 100% coverage gate. This document records intended work;
it does not assert that any enhancement has been implemented or validated.
