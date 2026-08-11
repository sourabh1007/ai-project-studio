# Usage & cost — credits, tokens, and time

AI Project Studio surfaces the **credit (AIC)**, **token**, **cost**, and **time**
each run consumes — sourced from the telemetry the CLIs already emit, not a
home-grown counter — and rolls those figures up across the whole hierarchy.

## Where to find it

- **Status bar (always visible):** the bottom bar shows live workspace totals —
  **IDE AI** overhead, total **AIC**, and input/output **tokens**.
- **Live credit meter:** each running session shows its own credits/tokens/time
  as they accrue.
- **Feature dashboard:** open a feature to see its charts and KPI cards.

## What rolls up where

Usage aggregates across the full **Feature → Group → Session** hierarchy, so a
feature's numbers include every session (and group) beneath it, and the workspace
totals include every feature.

Every AI call is tagged as either:

- a **user session** — the interactive development work you run, or
- an **IDE metasession** — internal steps the app runs on your behalf (session
  and feature **summaries**, **task plans**, **repository analysis**, and **PR
  reviews**).

This keeps internal overhead itemized and clearly labeled — the **IDE AI** figure
in the status bar is exactly this metasession overhead, kept separate from your
feature development cost. Metasession usage is broken down per query so you can
see which internal step spent what.

## Feature dashboard

Opening a feature shows:

- **KPI cards** — headline totals for the feature.
- **AIC-over-time** — credit spend across the feature's lifetime.
- **AIC-by-model** — how credit splits across models.
- **Time-by-session** — where time went.
- **Task plan** and **work summary** panels (see [Sessions](sessions.md) and
  below).

## AI task plans

From a feature you can generate a structured **task plan** — an AI-produced
breakdown of the work — and track progress against it in the dashboard.

## Summaries

Per-session and feature-level **summaries** are generated automatically (session
summaries on session end) and shown in the dashboard, giving a written record of
what was accomplished. See [Sessions](sessions.md#summaries).

## Related

- [Sessions](sessions.md) — where live metrics originate.
- [Feature categories](feature-categories.md) — the hierarchy usage rolls up.
- [Architecture](../architecture.md#live-usage--cost--ui) — the tail → normalize →
  credit → aggregate → SSE data flow.
