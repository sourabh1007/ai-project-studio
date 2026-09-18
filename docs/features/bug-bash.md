# Bug Bash

**Bug Bash** is an agent you attach to a feature to hunt edge-case bugs in its
repository: it **generates** test scenarios grounded in your description and the
repo code for you to review, then — on your approval — **runs** them across a
team of parallel tester agents and compiles a **findings report**.

> Bug Bash is an [agent](../agents.md). Attach it from a feature that has a
> linked repository; several can run on one feature. Unlike
> [New Task](new-task.md), Bug Bash **only reads** the repo — no worktree, no
> code edits, no pull request.

## The flow

```
Describe ──▶ Generate ──▶ Review ──▶ Run ──────────▶ Report
 feature      (AI          accept    (tester team     pass/fail
 + setup      analyst)     scenarios  in parallel)    + findings
```

1. **Describe** — write the **feature information** (what it does, its inputs
   and outputs) and optional **setup information** (doc/sample links, config,
   instructions the testers need).
2. **Generate** — a **scenario analyst** metasession reads the feature and the
   repository and proposes concrete, reviewable edge-case scenarios. Live logs
   stream as it works.
3. **Review** — read each scenario (input, steps, expected output, how to
   confirm). Accept them, or regenerate.
4. **Run** — a **lead agent** splits the accepted scenarios round-robin across
   specialized **tester** sub-agents that each lease their own metasession and
   run **in parallel**. The lead merges the verdicts and compiles the report.
5. **Report** — pass / fail / blocked / **needs-access** tallies, the compiled
   markdown findings, the agent team with time and AI credits, and every
   scenario's verdict with its **diagnostics**.

## Reading a verdict

Each scenario in the report carries the reproducible record and how its result
was reached:

- **Ran vs Not run** — whether a tester actually executed the steps, so a
  verdict grounded in a real run is distinguished from one that could not be
  attempted.
- **Expected vs Actual** — the expected behaviour beside the concrete output the
  tester observed.
- **Blocked categories** — a blocked scenario is tagged with why it could not
  run. **Needs access** (missing permission/credentials) is tallied and shown
  separately from non-permission blockers (environment, tooling, other) so
  access gaps triage apart from genuine "couldn't attempt" cases.
- **Diagnostics** — the ℹ️ control on a scenario opens its diagnostic /
  telemetry detail: the responsible tester and its metrics, expected vs actual,
  observations, and the raw log the tester captured.

## The agent team

The Run step shows the hierarchy live:

- **Agents & sub-agents panel** — the lead agent with its testers nested
  underneath, each tagged by role, with **live time, tokens, and AI credits**.
- Click any agent to open its **live log** (the exact prompt it was given, then
  its streamed reasoning and tool activity).
- Each tester card lists the **scenarios** it owns.

Running several testers on their own metasessions — drawing on the
[warm pool](../metasessions.md#runner-chain-composed-in-maints) — is what lets a
wide scenario set finish quickly instead of one at a time.

## Cancel & reset

An in-flight pass can be **cancelled** from the page: it aborts the background
metasessions (terminating any attached process) and resets the run. The
**accepted scenarios are preserved**, so you can re-run without regenerating.
Switching windows does **not** stop generation or a run — they continue in the
background and the page reconnects to the live logs when you return.

## Where the work lives

Every scenario, verdict, and agent snapshot is persisted per attachment
(`bug_bash_runs`), so the page rehydrates fully on reload. See
[backend-modules.md](../backend-modules.md) (`bug-bash/`) and
[metasessions.md](../metasessions.md) for the internals.
