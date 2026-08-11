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

- **Add a skill** — give it a name, a kind, and its instruction text.
- **Edit / delete** existing skills.
- Skills have a **kind** (shown as a chip) to distinguish, e.g., instruction-style
  blocks from other categories.

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

## Related

- [Sessions](sessions.md) — where seeded instructions are applied.
- [Feature categories](feature-categories.md) — features you tag skills onto.
- [Architecture](../architecture.md#session-readiness-and-bootstrap) — how skills
  are composed into the bootstrap.
