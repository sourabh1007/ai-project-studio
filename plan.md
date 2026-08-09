# Plan: Central, layered, shared-context store

> Status: **design agreed, not yet implemented.** Investigation done; four key
> decisions locked with the user (see "Decisions"). This document is the
> reference for implementation. No code has been written for this feature.

## Goal

Today, per-session context is composed *ephemerally at launch* and "memory"
flows only **forward and only within one feature**. We want a **central**
context store that is **continuously updated by sessions/features** and
**shared between sessions** — including reaching an **already-running (old)
session**, not just new ones.

## Decisions (locked with user)

1. **Scope** — Layered: **workspace-global → repo → feature** (CSS-cascade style;
   all three layers injected).
2. **Update model** — **Agent-curated merge on session end** (dedupe / supersede
   stale facts) **+ a manual "remember this"** path.
3. **Sharing / read** — **Both**: inject at launch **and** live-push into
   running sessions.
4. **Substrate** — **SQLite table, editable via the IDE UI** (single-blob per
   scope, mirroring the proven `repository_contexts` pattern).
5. **Workspace-global writes** — **manual-promotion-only**: nothing auto-writes
   to the global layer; it changes only via an explicit promote/edit action.

## How context works today (baseline)

Everything converges in `backend/src/session-bootstrap/session-bootstrap.ts →
composeForSession()`, called **at launch** by `session-launcher` and
`terminal-manager`. It builds an ephemeral `# Session Bootstrap Context` blob
from four sources:

| # | Source | Stored in | Writer | Scope |
|---|--------|-----------|--------|-------|
| 1 | Repository Context | `repository_contexts` (per `repoId`) | LLM generator from git *code evidence*; auto-`stale`→regenerate on revision change | repo |
| 2 | Feature name + description | `features` | human | feature |
| 3 | Prior Completed Dev Sessions | `session_summaries` | silent `meta` session summarizing each transcript | **feature only** |
| 4 | Effective Skill Instructions | `skills` / `skill_attachments` | human-authored, exportable | feature / session |

### Gaps vs. goal
- Ephemeral, read-only composition — no single *living* document read **and** written.
- Memory is forward-only and feature-bound (`priorSessionMemory()` filters
  `session.featureId === current.featureId`); can't reach old sessions or cross
  features/repos.
- Sessions never write back (only a read-only summary).
- Repo context is code-derived, not learning-derived.
- Skills are the only curated shareable instructions, but static & manual.

## Target design

### Data model — new table `context_documents`
Single-blob per scope (mirrors `repository_contexts`):
```
context_documents(
  scope       TEXT,   -- 'workspace' | 'repo' | 'feature'
  scope_id    TEXT,   -- '' (workspace) | repoId | featureId
  content     TEXT,   -- curated, instruction-style markdown
  updated_at  TEXT,
  updated_by  TEXT,   -- 'merge' | 'manual' | 'import'
  PRIMARY KEY (scope, scope_id)
)
```
Manual notes append as bullets, then a merge pass folds them in. The whole
document is editable in the UI.

### Injection at launch
Extend `composeForSession()` with a new top section `## Shared Context`,
concatenating the three layers **workspace → repo → feature** (most-general
first), each char-bounded like today's feature memory. Drops straight into the
existing `sections` array.

### Agent-curated merge (on `session.ended`, dev & non-internal)
Reuse the `session-summary-runner` machinery: spawn a silent `meta` session fed
*(current in-scope docs + this session's transcript/summary)*; prompt it to emit
an **updated, deduped, instruction-style** document (supersede stale facts).
Persist to the **feature** layer by default. Serialize merges with an
`inFlight` lock (as in `repository-context-coordinator`).

### Manual "remember"
`POST /context {scope, scopeId, text}` appends a note and triggers a light
merge. Same endpoint is the vehicle to **promote** a fact up to repo/workspace.

### Live-push to running (old) sessions
Emit a new `context.updated` bus event on any store change. Find running
terminals whose session matches the changed scope (workspace = all; repo /
feature = matching) and inject a `Context updated:` block via the **existing
terminal injection path** (the settle-and-submit logic already used for skill
tag/untag).

### UI
A "Context" panel at each level (workspace / repo / feature) showing the
editable document + provenance, styled like the repo-context / skills panels.

### Cross-cutting concerns
- Char budgets across the 3 layers (truncate like today's memory).
- Exclude `meta` / `internal` sessions from both read and merge (as today).
- Dedupe / supersede handled in the merge prompt.
- Extend `workspaceAdmin` cascade to delete a feature/repo's context on removal.
- Avoid re-injecting a session's own just-merged content mid-run.

### Reuse map
- **Reused as-is:** meta-summarizer, single-blob repo pattern
  (`repository_contexts`), live PTY injection, hexagonal repo→controller→routes,
  event bus, admin cascade.
- **New code:** one table + one service + one controller/routes + the merge
  prompt + a UI panel + `composeForSession` wiring + live-push hook.

## Two open sub-decisions (defaults proposed)
1. **Promotion policy** — *default:* merge writes to the **feature** layer;
   repo/workspace is **manual promotion**. *Alternative:* let the merge agent
   auto-decide the layer (riskier — global noise).
2. **Live-push style** — *default:* inject a short *"Context updated — N new
   facts"* note (non-disruptive). *Alternative:* inject the full changed text
   (more complete, more intrusive).

## Implementation checklist (once approved)
- [ ] Schema: add `context_documents` to a DB group + migration.
- [ ] Port + SQLite repo (`context-store`), following the hexagonal pattern.
- [ ] Context service: read/merge/append/promote + `inFlight` lock.
- [ ] Merge prompt builder + response extractor (reuse summarizer utils).
- [ ] Hook `session.ended` → merge (dev, non-internal only).
- [ ] Extend `composeForSession()` with the layered `## Shared Context` section.
- [ ] `context.updated` bus event + live-push via terminal-manager injection.
- [ ] Controller + routes (`GET`/`PUT` doc, `POST` remember/promote); wire deps.
- [ ] UI "Context" panels (workspace/repo/feature) + api.ts client.
- [ ] Cascade delete in `workspaceAdmin`.
- [ ] Tests to keep backend 100% / UI `src/lib` coverage gates green.
