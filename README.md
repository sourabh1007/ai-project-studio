# AI Project Studio

[![CI](https://github.com/sourabh1007/ai-project-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/sourabh1007/ai-project-studio/actions/workflows/ci.yml)

An **IDE-style desktop app** that turns AI coding CLIs (GitHub Copilot, Agency, …) into a project-centric, observable workspace. AI Project Studio organizes CLI work by **Feature → Session**, runs the interactive CLI in an embedded terminal, and surfaces live **credit (AIC), token, cost, and time** analytics for every run — sourced from the telemetry the CLIs already emit, not a home-grown counter.

It also layers AI-native productivity on top of the raw CLI: reusable **skills** (instruction blocks auto-seeded into sessions), AI-generated **feature task plans**, and automatic **session/feature summaries**.

Built as an npm-workspaces monorepo: a modular **Express** backend (ports & adapters), a **React + Vite** UI, and an **Electron** shell that ties them into a single desktop application.

> New here (human or AI agent)? Start with **[AGENTS.md](AGENTS.md)** and the **[docs/](docs/)** folder.

## Architecture (module-wise)

```mermaid
flowchart TB
    subgraph Desktop["🖥️ Electron Shell — desktop/"]
        Main["main.cjs · lifecycle · native theme"]
        Preload["preload.cjs · contextBridge"]
    end

    subgraph UI["🎨 UI — ui/  (React + Vite)"]
        Workspace["Workspace shell<br/>explorer · tabs · terminal"]
        FeatDash["Feature dashboard<br/>charts · tasks · summaries"]
        SkillsUI["Skills manager"]
        UsageUI["Usage & cost"]
        SettingsUI["Settings"]
    end

    subgraph API["⚙️ Backend API — backend/src/api  (Express · SSE · WS)"]
        Routes["route table · controllers · usage stream"]
    end

    subgraph Domain["Backend domain modules — backend/src"]
        subgraph Org["Work organization"]
            feature["feature"]
            session["session"]
            tasks["feature-tasks"]
            skills["skills"]
        end
        subgraph Exec["Execution"]
            provider["provider registry<br/>copilot · agency adapters"]
            terminal["terminal (node-pty)"]
            meta["meta"]
        end
        subgraph Tel["Telemetry & cost"]
            usage["usage (CLI/OTel tail)"]
            credit["credit"]
            aggregation["aggregation"]
            ideUsage["ide-usage"]
        end
        subgraph Know["Knowledge"]
            summarizer["summarizer"]
            sessionSummary["session-summary"]
            sessionImport["session-import"]
            copilotHistory["copilot-history"]
        end
        subgraph Plat["Platform"]
            kernel["kernel (bus · clock · log)"]
            config["config (namespaced)"]
            persistence["persistence (node:sqlite)"]
            workspaceMod["workspace"]
        end
    end

    subgraph CLIs["🤖 External AI CLIs"]
        Copilot["GitHub Copilot CLI"]
        Agency["Agency CLI"]
    end

    DB[("SQLite<br/>workspace.db")]
    CliDB[("CLI session-store.db")]

    Main -- spawns --> API
    Main -- loads --> UI
    UI <-- "HTTP · SSE · WS" --> Routes
    Preload -. "theme IPC" .-> Main

    Routes --> Org & Exec & Tel & Know
    provider --> Copilot & Agency
    terminal -- PTY --> CLIs
    CLIs -- usage rows --> CliDB
    CliDB -- tailed by --> usage
    usage --> credit --> aggregation --> Routes
    Org & Tel & Know --> persistence --> DB
```

See **[docs/architecture.md](docs/architecture.md)** for the detailed data flow and **[docs/backend-modules.md](docs/backend-modules.md)** for a per-module reference.

## Features (high level)

- **Feature → Session organization** — group CLI runs under named features; add, rename, and delete inline.
- **Embedded interactive terminal** — run the Copilot/Agency chat TUI in an `xterm.js` terminal that fills the workspace like an editor tab.
- **Live usage & cost analytics** — real-time credit (AIC), token, cost, and time streamed over SSE from the CLIs' own telemetry.
- **Feature dashboard** — AIC-over-time, AIC-by-model, and time-by-session charts plus KPI cards.
- **Skills** — reusable instruction blocks you tag onto features/sessions; automatically seeded into a session's first prompt.
- **AI feature task plans** — generate a structured task breakdown for a feature and track progress.
- **Automatic summaries** — per-session summaries on session end, plus feature-level work summaries.
- **PR review workspace** — an "Open a PR" flow with a dedicated review page: problem statement, blind proposal, syntactic + business-logic review, 0–100 scoring, and a per-file **change graph** that highlights PR-modified functions and their connections.
- **Live PR comments** — read and post review comments inline against the exact file/line while reviewing; comments sync back to the PR (GitHub & Azure DevOps) and render with **Markdown/GFM** support.
- **Generic nested usage tracking** — usage rolls up across **Feature → Group → Session**, with every AI call tagged as an **IDE metasession** or a **user session**, so internal steps (including PR reviews) are itemized and clearly attributed.
- **Session import** — pull in past provider-native sessions (Copilot/Agency history) as workspace sessions.
- **Multi-provider by design** — a pluggable provider registry; Copilot and Agency ship today, new CLIs slot in behind one interface.
- **Local-first persistence** — features, sessions, usage, transcripts, and summaries in SQLite (`node:sqlite`).
- **Light & dark themes** with native window chrome.

## Copilot App vs. AI Project Studio

The GitHub Copilot app/CLI is a single-conversation coding assistant. AI Project Studio wraps that same CLI in a project-centric, observable workspace — it doesn't replace the CLI, it organizes and instruments it.

| Feature | Copilot App / CLI | AI Project Studio |
| --- | --- | --- |
| **Primary unit of work** | A single chat/session | **Feature → Session** hierarchy grouping many runs |
| **Interface** | Terminal or editor chat pane | **IDE-style desktop app** (Electron) with an embedded `xterm.js` terminal |
| **Usage & cost visibility** | Per-response, ephemeral | **Live credit (AIC), token, cost & time** streamed over SSE and persisted per session/feature |
| **Analytics dashboards** | None | **Feature dashboard**: AIC-over-time, AIC-by-model, time-by-session charts + KPI cards |
| **Reusable instructions** | Manual copy/paste each session | **Skills** — instruction blocks tagged to features/sessions and auto-seeded into a session's first prompt |
| **Task planning** | Ad hoc, in-conversation | **AI-generated feature task plans** with progress tracking |
| **Summaries** | None persisted | **Automatic per-session and feature-level summaries** |
| **PR review** | Manual prompting | **"Open a PR"** flow: dedicated review page with problem statement, blind proposal, syntactic + business-logic review, and 0–100 scoring |
| **Metasession attribution** | N/A | Internal AI steps run as **metasessions** with **itemized, clearly-labeled** credit/token usage |
| **History** | Provider-native store only | **Imports** provider-native (Copilot/Agency) history as workspace sessions |
| **Provider support** | GitHub Copilot only | **Pluggable provider registry** — Copilot and Agency today, more behind one interface |
| **Persistence** | CLI's own session store | **Local-first SQLite** (`node:sqlite`): features, sessions, usage, transcripts, summaries |
| **Configuration** | CLI flags / config file | **Namespaced, editable config** surfaced in a Settings UI |

In short: the Copilot app is the *engine*; AI Project Studio is the *cockpit* — it turns raw CLI runs into an organized, measurable, multi-provider workflow.

## Getting Started

### Prerequisites
- **Node.js ≥ 22.5** (the backend uses the built-in `node:sqlite` module)
- **GitHub Copilot CLI** and/or **Agency CLI** installed and on your `PATH`

### Install
```bash
git clone https://github.com/sourabh1007/ai-project-studio.git
cd ai-project-studio
npm install
```

### Run the desktop app
```bash
npm run desktop      # builds backend + UI, launches the Electron shell
```

### Development
```bash
npm run dev          # backend + UI with hot reload (browser)
npm run desktop:dev  # Electron shell pointed at the dev server
```

### Build & test
```bash
npm run build                          # build backend and UI
npm run test:coverage --workspace backend   # backend suite (100% coverage gate)
npm run test:coverage --workspace ui        # UI suite
npm run lint                           # typecheck the backend
```

## Releases

Every push and pull request runs the **CI** workflow (build + backend/UI coverage gates), so broken code can't land on `main`.

To cut a release, push a version tag — the **Release** workflow builds installers for both platforms and attaches them to a GitHub Release:

```bash
git tag v0.8.0
git push origin v0.8.0
```

Produces:
- **Windows** — `.exe` (NSIS installer), **code-signed with [Azure Trusted Signing](https://learn.microsoft.com/azure/trusted-signing/)** so it installs without the "Unknown Publisher" SmartScreen warning.
- **macOS** — `.dmg` (currently **unsigned** — no Apple Developer Program membership).

> The packaged app spawns the backend with the system Node runtime, so end users need **Node.js ≥ 22.5** installed.

**Windows signing** activates automatically when the Azure Trusted Signing secrets are configured on the repo (see [docs/development.md → Code signing](docs/development.md#code-signing)); if they're absent the Release workflow still succeeds and just emits an unsigned installer.

**macOS (unsigned) — bypass Gatekeeper on first launch.** Because the `.dmg` isn't signed/notarized, macOS shows *"AI Project Studio can't be opened because Apple cannot check it for malicious software."* To run it:
> - **Right-click** the app in Finder → **Open** → **Open** (only needed the first time), or
> - clear the quarantine flag: `xattr -dr com.apple.quarantine "/Applications/AI Project Studio.app"`.

## Project Structure

| Path | Description |
| --- | --- |
| `backend/` | Express API + domain modules (TypeScript, ports & adapters) |
| `ui/` | React + Vite front-end |
| `desktop/` | Electron shell (spawns the backend, loads the UI) |
| `docs/` | Architecture, module reference, and contributor/agent guides |
| `AGENTS.md` | Entry point and working agreement for AI agents & new contributors |

## Documentation

| Doc | What's inside |
| --- | --- |
| [AGENTS.md](AGENTS.md) | How to work in this repo: conventions, invariants, workflow |
| [docs/architecture.md](docs/architecture.md) | Layers, data flow, key patterns |
| [docs/backend-modules.md](docs/backend-modules.md) | Per-module responsibilities & key files |
| [docs/ui-guide.md](docs/ui-guide.md) | UI structure, feature areas, and what's actually mounted |
| [docs/development.md](docs/development.md) | Setup, scripts, testing, debugging, env quirks |
| [docs/adding-a-provider.md](docs/adding-a-provider.md) | Add a new CLI tool behind the provider interface |

## License

Private project.
