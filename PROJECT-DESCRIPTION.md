# AI Project Studio

> **The cockpit for AI coding CLIs.** Turn GitHub Copilot, Agency, and other AI
> coding CLIs into a project-centric, fully observable desktop workspace — with
> live cost, token, and time analytics on every run.

[![CI](https://github.com/sourabh1007/ai-project-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/sourabh1007/ai-project-studio/actions/workflows/ci.yml)

---

## 🎯 What it is

**AI Project Studio** is an **IDE-style desktop application** that wraps the AI
coding CLIs you already use inside a structured, observable workspace. Instead of
a single throwaway chat, your AI work is organized as **Repository → Feature →
Group → Session**, runs in an embedded terminal, and is instrumented end-to-end.

> [!IMPORTANT]
> AI Project Studio **does not replace** your AI CLI — it **organizes and
> instruments** it. The Copilot/Agency CLI is the *engine*; AI Project Studio is
> the *cockpit*.

It is **multi-provider by design** (a pluggable registry ships Copilot & Agency
today), works with **both GitHub and Azure DevOps**, is **local-first** (all data
in on-device SQLite), and built as a modular **Express + React + Electron**
monorepo.

---

## ✨ Highlighted features

### 📊 Live cost & usage analytics
See **credits (AIC), tokens, cost, and time** for every run — sourced from the
**telemetry the CLIs already emit**, not a home-grown estimator. Feature-level
dashboards and **IDE-AI attribution** roll usage up across the entire hierarchy.

> [!TIP]
> Because metrics come straight from the CLI's own telemetry, the numbers match
> your provider billing instead of approximating it.

### 🗂️ Project-centric organization
Every run is filed under **Repository → Feature → Group → Session**, so AI work
maps to real project structure — not a flat, unsearchable chat history.

### 💻 Embedded AI terminal
Run the Copilot/Agency chat TUI in a real `xterm.js` terminal, complete with
**launch-time context bootstrap**, **automatic session & feature summaries**, and
**history import** from prior CLI sessions.

### 🤖 New Task — a team of parallel agents
Attach the **New Task agent** to a feature and it solves a problem end-to-end:
it **plans** the change for your review, then **implements** it with a *lead
agent plus parallel developer/tester sub-agents*, streaming a **live agent
hierarchy** with per-agent time/token/credit metrics and per-file diffs — and
opens a pull request.

### 🔀 PR reviews, built in — GitHub **and** Azure DevOps
An **"Open a PR"** flow with a dedicated review page: AI summary, **0–100
scoring**, a navigable per-file **change graph** (zoom/pan/full-screen), inline
diffs, **live PR comments**, and **one-click Approve** — with **first-class
support for both GitHub and Azure DevOps** repositories.

### 🔌 MCP servers, fully managed
Add, edit, and **restart** Model Context Protocol servers, discover their tools,
and **toggle individual tools live** — applied to open sessions **without a shell
restart**. Connection status, tool availability, and **auth (with one-click
sign-in)** are surfaced right in the UI, and **per-server tool usage is metered
at both the feature and IDE level**.

### ⚙️ Monitors & automations
Background monitors run **shell, HTTP, AI, or CI checks** on an interval,
evaluate conditions, and fire **metasession, subagent, report, or command**
actions.

### 🧩 Reusable skills
Author **instruction blocks** once, tag them onto features/sessions, and have
them **auto-seeded** into a session's first prompt.

### 🪟 A workspace that flexes
**Detachable windows** — pop **Sessions and Agent boards** out into their own OS
window and return them with one click. **Responsive modals**, **light/dark
themes**, and **native window chrome** round out the experience.

---

## 🏗️ Architecture at a glance

| Layer | Tech | Responsibility |
| --- | --- | --- |
| **Electron shell** (`desktop/`) | `main.cjs` · `preload.cjs` | Lifecycle, native theme, spawns backend, loads UI |
| **UI** (`ui/`) | React + Vite | Workspace, dashboards, skills, automations, usage, settings |
| **Backend API** (`backend/src/api`) | Express · SSE · WS | Route table, controllers, live usage stream |
| **Domain modules** (`backend/src`) | TypeScript (ports & adapters) | Features, sessions, providers, MCP, telemetry, knowledge |
| **Persistence** | `node:sqlite` | Local-first `workspace.db` + attached siblings |

> [!NOTE]
> Built as an **npm-workspaces monorepo** with a modular backend (ports &
> adapters), a React + Vite UI, and an Electron shell that ties them into a
> single desktop application. See
> [`docs/architecture.md`](docs/architecture.md) for the full data flow.

---

## 🚀 Getting the app

AI Project Studio ships as a **Windows `.exe` installer** (NSIS). Grab the latest
build from the project's **[GitHub Releases](https://github.com/sourabh1007/ai-project-studio/releases)**
page and run it — no cloning, no `npm install`, no build step.

> [!WARNING]
> **Unsigned prerelease.** The installer is an **internal, unsigned candidate**
> and is **not production-qualified**. On first launch Windows may show an
> **unknown-publisher / SmartScreen** warning — choose **More info ▸ Run anyway**
> if you have independently established the build is trustworthy. A macOS `.dmg`
> is produced but is currently **unsigned and un-notarized** (Gatekeeper may
> block it).

**Prerequisites**
- **Node.js ≥ 22.5** on your `PATH` — the packaged app spawns the backend with
  your system Node runtime (the backend uses the built-in `node:sqlite` module).
- **GitHub Copilot CLI** and/or **Agency CLI** installed and on your `PATH`.

Once installed, the app **checks GitHub Releases for updates** on launch and in
the background, and notifies you in-app when a newer version is available.

---

## 🆚 How it differs from the Copilot app

The GitHub Copilot app/CLI is a **single-conversation** coding assistant. AI
Project Studio wraps that **same CLI** in a **project-centric, observable
workspace**:

- ✅ **Structured** work (Repository → Feature → Group → Session) vs. a flat chat
- ✅ **Full cost/token/time observability** vs. no first-party analytics
- ✅ **Parallel agent teams & PR review** vs. a single conversation
- ✅ **Managed MCP servers with live tool toggles & usage metering**
- ✅ **Multi-provider** (Copilot & Agency, pluggable) vs. one engine

See [`docs/vs-copilot-app.md`](docs/vs-copilot-app.md) for the full side-by-side.

---

## 📄 License

Private project.
