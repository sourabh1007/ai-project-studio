# Sessions — running the AI CLI

A **Session** is a single interactive run of an AI coding CLI (GitHub Copilot,
Agency, …) inside AI Project Studio. Each session runs the real CLI chat TUI in
an embedded terminal, streams its output live, and records the credits, tokens,
cost, and time it uses.

## Where to find it

Sessions live under a **Feature** in the **Explorer** (Files icon). Expand a
feature to see its sessions; each has a colored status dot and a live metrics
readout.

## Start a session

1. In the Explorer, expand the **Feature** (or Group) you want to work under.
2. Click the **`+` (new session)** button on that feature.
3. In the form, pick the **provider** and **model** (shared pickers), then start.
   - For repository-backed features the `+` is disabled until the repository
     context badge reads **Ready** (see [Feature categories](feature-categories.md)).
4. The session opens as an **editor tab** with an embedded terminal filling the
   pane — chat with the AI exactly as you would in the CLI.

> Tip: the default **Scratchpad** feature lets you start a session without any
> setup — see [Feature categories](feature-categories.md#the-default-scratchpad).

## Working in the terminal

- The terminal is a full `xterm.js` terminal wired to the CLI over a WebSocket.
- Multiple sessions open as separate tabs; the tab strip scrolls when full.
- On launch the backend seeds a **context bootstrap** into the session — the
  ready repository summary, the feature name/description, summaries of prior
  completed sessions, and any effective [skills](skills.md) — so the CLI starts
  with the right background. You don't paste this yourself.

## Live metrics

While a session runs, its **live credit meter** shows credits (AIC), tokens, and
time as they accrue, sourced from the CLI's own telemetry. Totals roll up to the
feature and workspace. See [Usage & cost](usage-and-cost.md).

## Summaries

When a session ends, the app can automatically generate a concise **session
summary**. Feature-level **work summaries** combine those into an overview of
everything done under a feature. Both appear in the feature dashboard.

## Import past sessions

You can pull provider-native history (Copilot/Agency past sessions) into the
workspace:

1. Open the **Import session** panel from the Explorer.
2. Pick the past sessions to import; they become workspace sessions under a
   feature so their transcripts and usage are visible alongside new work.

## Rename & delete

Use a session's overflow (`⋯`) menu to rename or delete it. Session names persist
across restarts.

## Related

- [Feature categories](feature-categories.md) — where sessions live.
- [Skills](skills.md) — instructions auto-seeded into a session's first prompt.
- [Usage & cost](usage-and-cost.md) — live meters and dashboards.
- [Architecture](../architecture.md#running-an-interactive-session) — PTY,
  bootstrap timing, and transcript capture internals.
