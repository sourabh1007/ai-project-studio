# MCP servers — Model Context Protocol

The **MCP Servers** view manages the Model Context Protocol servers that a
provider's CLI can use, and lets you enable or disable individual **tools** — with
changes applying to already-open sessions without restarting the app.

## Where to find it

Click the **MCP** icon in the activity bar to open the **MCP Servers** view. It
reflects the real config file the selected provider's CLI reports, so entries
match what the CLI actually uses.

## Manage servers

For the selected provider, each configured server appears as a **card** showing
its spec summary. From a card you can:

- **Add** a server — click **Add MCP server** and fill in the spec
  (type/command/args, etc.).
- **Edit** a server — the pencil icon opens the same form pre-filled.
- **Restart** a server — the refresh icon restarts it and re-runs tool discovery.
  If the server needs **authentication**, the prompt surfaces as part of the
  restart/discovery flow, so auth "just works" without leaving the app.

## Tools

Each card has a **Tools** button showing the discovered tool count. Click it to
open the **tools modal**, which lists every tool the server exposes with a short
description and a checkbox:

- **Check / uncheck** a tool to enable or disable it.
- The modal also has a **Restart** button and shows discovery status/output
  (including any device-code or auth messages).

## Live apply — no shell restart

Both **tool toggles** and **server restarts** take effect for **already-open
sessions**: the app sends the provider's live-reload command to affected sessions
and reports how many were reloaded. New sessions always pick up the latest config.

## Related

- [Sessions](sessions.md) — sessions that consume MCP tools.
- [Architecture](../backend-modules.md) — the `mcp/` backend module.
