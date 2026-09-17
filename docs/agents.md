# Agents

An **agent** is an isolated, attachable analysis/automation surface a user
attaches to a **feature**. Agents are contributed to a registry and never
hand-wired into core: the host owns attachment, prerequisite gating, usage
roll-up, and the management view generically. Three ship today:

| Agent | Attaches when | Does |
| --- | --- | --- |
| **Review Board** | the feature has a PR review | Scores and analyses a pull request ([PR reviews](features/pr-reviews.md)). |
| **New Task** | the feature has a linked repository | Plans and implements a change, then opens a PR ([New Task](features/new-task.md)). |
| **Bug Bash** | the feature has a linked repository | Generates edge-case test scenarios, runs them across a tester team, and reports what breaks ([Bug Bash](features/bug-bash.md)). |

An agent:

- renders as a **workspace tab** on the feature it is attached to;
- talks to AI **[metasessions](metasessions.md)** through a scoped `MetaRunner`
  (never the raw launcher), with every turn tagged for usage roll-up;
- owns its **prompts + config** (editable from the **Agents** view);
- is **sandboxed** — a broken agent renders a fallback and can never take down
  the shell.

> "Agent" here means an attachable *feature* agent. It is unrelated to the AI
> coding agents that work on this repo (`AGENTS.md`) or to
> `automation`/`subagent` background runs.

## Rules the host enforces

1. **Prerequisite gating** — an agent declares what a feature must have before
   it can attach; the UI only offers it where the prereq is met and the backend
   re-checks on attach.
2. **Multiplicity** — each manifest sets `allowMultiplePerFeature`. Review Board
   is single-instance; New Task and Bug Bash allow many (one per problem or
   feature under test).
3. **Isolation** — capabilities are **injected**, routes and config are
   **namespaced** (`/agents/:id/*`, config namespace = id), and manifests are
   validated at registration. An agent cannot reach globals, the DB, the
   launcher, or another agent.
4. **Usage roll-up** — every AI turn is tagged with the manifest's `usageLabel`,
   so the Agents view can show average credits per run.

## Where it lives

| Piece | Path |
| --- | --- |
| Platform contract | `backend/src/agents/agent-contract.ts` |
| Registry + service | `backend/src/agents/agent-registry.ts`, `agent-service.ts` |
| Shipped agents | `backend/src/agents/review-board-agent.ts`, `new-task-agent.ts`, `bug-bash-agent.ts` |
| UI host + registry | `ui/src/agent-host/` |
| UI agent modules | `ui/src/agents/<id>/<id>-module.tsx` |

Attachments are persisted (`agent_attachment(featureId, agentId)`, mirroring
skill attachments) and both agents are registered in one array in `main.ts`
(`createAgentRegistry([...])`).

## Host routes (generic)

| Route | Purpose |
| --- | --- |
| `GET /agents` | Catalog: manifest + average credits per run. |
| `GET /agents/:id` | One agent's config, prompt fields, usage summary. |
| `GET /features/:featureId/agents` | Agents attached to a feature. |
| `GET /features/:featureId/agents/available` | Types that can attach now. |
| `POST /features/:featureId/agents` | Attach `{ agentId }`. |
| `DELETE /features/:featureId/agents/:attachmentId` | Detach. |
| `/agents/:id/*` | The agent's own routes, auto feature-scoped. |

## Adding an agent

Adding an agent touches **only its own folders plus the two registry arrays** —
nothing in core changes:

1. **Backend** `backend/src/agents/<id>-agent.ts` — an `AgentDefinition`:
   `manifest` (id, title, icon, `allowMultiplePerFeature`, prerequisite,
   `usageLabel`), `promptFields`, and `routes(ctx)`. Drive metasessions via
   `ctx.ai.runDetailed(...)`; keep logic pure behind ports.
2. **Frontend** `ui/src/agents/<id>/<id>-module.tsx` — an `AgentUiModule` whose
   lazy `component` renders the tab through the injected `ctx` (no core imports).
3. **Register** in `createAgentRegistry([...])` (backend) and the UI registry.
4. **Test** the definition + service; keep backend coverage at **100%** (only
   thin host IO adapters go on the coverage `exclude` list).
