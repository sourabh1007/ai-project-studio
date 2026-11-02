# Sessions — running the AI CLI

A **Session** is a single interactive run of an AI coding CLI (GitHub Copilot,
optional Agency, or native Claude Code v2) inside AI Project Studio. Each session runs the real CLI chat TUI in
an embedded terminal, streams its output live, and records the credits, tokens,
cost, and time it uses.

## Where to find it

Sessions live under a **Feature** in the **Explorer** (Files icon). Expand a
feature to see its sessions; each has a colored status dot and a live metrics
readout.

## Start a session

1. In the Explorer, expand the **Feature** (or Group) you want to work under.
2. Click the **`+` (new session)** button on that feature.
3. Select/install the global **active CLI** in **Settings → CLI** or the CLI
   picker. The new-session form uses that eligible installed CLI and accepts an
   optional initial prompt. Pick the interactive **model inside the native
   shell**, not a model field in this form.
   - Repository context builds in the background; a pending or failed summary
     does not by itself disable session creation.
4. The session opens as an **editor tab** with an embedded terminal filling the
   pane — chat with the AI exactly as you would in the CLI.

**Remember me** controls whether the global CLI choice survives backend restart.
Switching CLI requires confirmation and safe shutdown of affected interactive
work; background execution can block switching without deleting sessions.
Installing requires an explicit **Install and use** action, not mere detection.
Agency additionally requires authorized-user opt-in in Settings → CLI.

Claude supports recognized native **v2** builds. Native subscription sign-in is
for interactive use; app-driven headless summaries, planners and agents require
operator-owned supported API/cloud credentials. Interactive sign-in does not
grant headless entitlement.

Headless work has additional safety gates: automated **Agency** summaries,
planners and agents are currently blocked because native tool defaults/overlays
cannot be safely isolated; interactive Agency sessions are unaffected.
Copilot/Claude can refuse automated runs when native configuration cannot be
safely inspected or suppressed. Follow the actionable native/admin guidance
or select another eligible provider; installing or signing in does not bypass
these gates.

## Working in the terminal

- The terminal is a full `xterm.js` terminal wired to the CLI over a WebSocket.
- Multiple sessions open as separate tabs; the tab strip scrolls when full.
- On launch the backend seeds a **context bootstrap** into the session — the
  ready repository summary, the feature name/description, summaries of prior
  completed sessions, and any effective [skills](skills.md) — so the CLI starts
  with the right background. You don't paste this yourself.

## Live metrics

While a session runs, its **live credit meter** shows credits (AIC), tokens, and
time as reported by the provider. Unreported AIC/quota is unavailable, not zero;
separately labelled USD estimates are not AIC. Totals roll up to the
feature and workspace. See [Usage & cost](usage-and-cost.md).

## Summaries

When a session ends, the app can automatically generate a concise **session
summary**. Feature-level **work summaries** combine those into an overview of
everything done under a feature. Both appear in the feature dashboard.

## Import past sessions

Where the provider advertises history import (including Agency and Claude), you
can pull native past sessions into the workspace. Do not assume every registered
provider has a standalone import hook:

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
