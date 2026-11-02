# Skills — reusable instructions

**Skills** are reusable blocks of instructions (guidance, conventions, personas)
that you tag onto features or sessions. When a session starts, the instructions
from its effective skills are **automatically seeded into the CLI's first
prompt**, so you don't copy/paste the same guidance every time.

## Where to find it

Click the **Skills** icon in the activity bar to open the **Skills** view. Skills
are also surfaced inline in the Explorer as **skill chips** on features and
sessions, with a **tagger** to attach/detach them.

## Create and manage skills

In the Skills view you can:

- **Add a skill** — give it a name, instruction text, and a **kind**:
  `prompt` for guidance or `mcp` for MCP-related setup instructions.
- **Edit / delete** existing skills.
- Set **recommended scope** to `feature`, `session`, or `both`; this guides
  attachment, rather than silently attaching the skill everywhere.
- Add **removal instructions** when detaching requires explicit cleanup.
  Detaching guidance is not proof that a native tool or configuration was undone.
- **Download JSON** exports the library; **Upload JSON** imports definitions.
  Imports can partially succeed: inspect per-item failures before retrying,
  rather than assuming the upload was atomic.

An `mcp` skill is still guidance/setup content. Attaching it does not prove that
the provider enabled a server or invoked a tool; inspect [MCP sources](mcp-servers.md).

## Tag skills onto work

- On a **feature** or **session** in the Explorer, use the **skill tagger** to
  attach one or more skills. Attached skills show as **chips**.
- Skills tagged on a feature apply to sessions started under it; skills tagged on
  a session apply to that session.

## How seeding works

When a session launches, the backend composes the effective skill instructions
(feature-level + session-level) and includes them in the launch **bootstrap**
alongside repository and prior-session context — so the CLI begins already aware
of your conventions. Because skills are evaluated **at launch time**, edits take
effect for the next session you start.

## Shared Context

Shared Context panels are available in repository/feature workspace surfaces
alongside the Skills library. They edit standing **workspace → repository →
feature** guidance and show AI-curation status separately from reusable skill
definitions. The applicable layers enrich future development and internal
sessions. You can append a local text/Markdown file to the editor, review it,
then explicitly save; selecting
a file is not itself a save. If loading or saving is unavailable, the panel
reports an error—do not assume an unsaved draft reached a running CLI.
AI merges detect a changed saved document before committing, rather than
overwriting a concurrent manual edit. A conflict requires reloading/reviewing
the latest saved guidance. Live sharing status is not proof that a model
executed an instruction; AI-curated context and skill attachment remain
different concepts.

## Related

- [Sessions](sessions.md) — where seeded instructions are applied.
- [Feature categories](feature-categories.md) — features you tag skills onto.
- [Architecture](../architecture.md#session-readiness-and-bootstrap) — how skills
  are composed into the bootstrap.
