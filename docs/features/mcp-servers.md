# MCP servers — Model Context Protocol

The **MCP Servers** view inspects and, where supported, edits documented MCP
configuration sources. It is not a complete inventory of tools in an active CLI.

## Where to find it

Click **MCP** in the activity bar. Choose **Copilot**, authorized optional
**Agency**, **Claude**, or **This App**. These are management categories, not an
instruction to switch the active execution provider.

Cards identify source scope and provenance. Workspace trust, overlays, inherited
configuration and managed policy can affect what the CLI ultimately loads.
Inherited/resolved sources can be read-only; a native provider can own settings
that this app cannot safely edit. Use only actions the selected source advertises.
**This App** describes the app's own tools, not a vendor's effective inventory.

## Manage configuration

For writable sources, **Add MCP server** and **Edit** accept a structured server
specification (transport, command/arguments or URL as supported). Keep each
argument separate, including Windows paths containing spaces. Avoid placing
credentials in command text; use the source's supported environment/auth mechanism.

Empty files load as unconfigured; UTF-8 BOM JSON is supported. Malformed nonempty
files produce a repairable error, not a silent reset, and sensitive raw contents
are withheld. Writes atomically replace the complete configuration.

## Inspect tools

**Tools** shows a verified tool inventory and descriptions where discovery is
supported. **Refresh tools** makes an independent, bounded discovery connection.
It does **not** restart a running CLI, reconnect its existing server, or prove
that a native session has enabled those tools. There are no generic per-tool
enable/disable checkboxes. Unsupported inspection remains explicitly unavailable.

Authentication and permissions remain provider/server-owned. A probe can report
that sign-in is required and show a safe supported sign-in link; this is not a
promise that every OAuth flow can finish inside the app. Raw discovery output
and credentials are not displayed. Retry after completing native authentication.
Inspection uses the backend-reported discovery budget plus cleanup headroom;
a timeout is a failed inspection, not proof of an authentication failure.

## When changes apply

Ordinary configuration edits apply to **subsequent CLI launches**, not all open
sessions. Explicit **Agency global built-in** changes have their own supported
session-recycling path and report failures. Do not equate that exception with
generic live reload, server restart, or Claude tool allow-list support.

## Related

- [Sessions](sessions.md) — active CLI selection and native authentication.
- [Backend module reference](../backend-modules.md) — MCP service boundaries.
- [Integration qualification](../integration-qualification.md) — deterministic
  coverage versus real server/authentication qualification.
