# Packaged desktop regression foundation (WP00/WP01)

This is a **shell smoke**, not native input or production-readiness certification.
It starts the actual packaged shell, its BrowserWindow and preload, but substitutes
a synthetic HTTP backend/document. It checks document identity and acknowledged
version IPC. It never imports the production backend or renders the production UI.

## Commands

From the repository root (Node 22+ and existing npm dependencies):

```powershell
npm run test:desktop:harness
npm run test:desktop:smoke -- --exe "C:\candidate\AI Project Studio.exe"
npm run test:desktop:smoke -- --ready-delay-ms 500 --timeout-ms 30000 --seed 42
```

`--exe` or `CW_TEST_EXE` selects an **unpacked/installed executable**, not an
installer. The default is `desktop/release/win-unpacked/AI Project Studio.exe`.
On macOS pass the executable inside `Contents/MacOS`; Linux requires an unpacked
executable with adjacent `resources/app.asar`. Non-Windows packaged trials are
not qualified by WP00's Windows development run.

`--out` selects a results parent (default `desktop/test-results`, ignored by git).
Each invocation creates a fresh child directory; never supply a live profile as
a fixture. `--timeout-ms` is bounded to 1–60 seconds, delayed readiness to 0–5
seconds. Source/package preflight and hashing precede launch; CDP operations have
their own five-second limits. Cleanup has separate bounded waits. The seed is
recorded for reproducibility; the current smoke does not randomize its inputs.

Before execution, the harness compares packaged shell/fixture sources with the
checkout. Legacy or stale packages are **unsupported (exit 2)** and are never
launched. Build a new candidate via the existing stage/packaging workflow when
needed; the harness does not build, install, update, or rewrite an existing
artifact. A smoke pass exits 0; a failed or interrupted trial exits 1.

## Isolation and ownership

- A new cwd, HOME/USERPROFILE, APPDATA/LOCALAPPDATA, XDG directories, Chromium
  profile and scratch directory are created under each run. The child environment
  is allow-listed: no inherited tokens, CLI shims, `CW__*`, `NODE_OPTIONS`,
  development-mode switches or updater simulation flags.
- `CW_DESKTOP_SMOKE_ROOT` plus a generated marker/token select the dedicated
  desktop test seam. It validates cwd, profile environment and fixture bytes
  before the shell reads its theme or obtains its single-instance lock.
  No global "AI off" switch is assumed. The backend is a dependency-free fixture,
  providers are empty, and the updater is a no-op object (including menu/IPC calls).
  Normal launches have no changed configuration or disabled features.
- The backend and CDP use loopback only. CDP's port is allocated by Chromium;
  the backend port and PIDs are discovered at runtime. No hardcoded process IDs
  or foreground-window assumptions are used.
- Windows creates the application suspended, assigns it to a kill-on-close Job
  Object, then resumes it. Controller EOF/crash closes the job via the PowerShell
  supervisor; descendants cannot escape through an early parent exit. The helper
  uses `-NoProfile` and does not run user shell initialization. POSIX uses a
  process group for normal/interrupt cleanup; abrupt controller SIGKILL cleanup
  is not qualified there. Fixture/supervisor watchdogs bound abandoned runs.
- No clipboard read/write or native key injection occurs. CDP evaluates only
  synthetic-document readiness and version IPC; it is **not** evidence of native
  focus, paste or keyboard routing. Native input must later verify the owned
  foreground window and report unsupported trials, rather than guess.

### Explicit clipboard IPC scenario (WP01)

The default smoke still never touches the clipboard. On an **idle, dedicated
desktop only**, opt in to the real packaged main/preload write/read boundary:

```powershell
npm run test:desktop:smoke -- --exe "C:\candidate\AI Project Studio.exe" --clipboard --timeout-ms 60000
```

This uses the same isolated synthetic document/backend and production clipboard
IPC; it does not run the production UI, a provider, or inject native keys. It
roundtrips 32,768, 32,769, 65,536, 1,048,576 and 4,194,304 UTF-16 code units,
including emoji and CRLF, verifies over-limit/empty rejection leaves a known
baseline untouched, and verifies explicit clear. Results contain sizes and
outcomes only. This is **not a physical paste/focus/first-shortcut qualification**.

Original clipboard text/HTML/RTF/PNG formats are held in main-process memory and
restored/verified best effort. Unknown/custom/file formats return unsupported
before mutation. Clipboard managers, delayed formats and concurrent users cannot
be made transactional through Electron: never run this opt-in on an active shared
desktop. Restoration is attempted only while the final synthetic marker still
owns the clipboard. A crash/interruption/ownership loss may leave synthetic text;
the manifest reports failed or skipped restoration, never silently declares a
pass. No clipboard content is written to artifacts or logs.

WP01 source/IPC fake and handler-fixture tests do not access the shared OS
clipboard. Native packaged and physical-input gates remain open until separately
run and recorded for the candidate/platform.

### Clipboard contract

- `desktop.copyText(text)` returns `Promise<ClipboardResult>`: `{ ok: true }`
  only after a native write and exact readback; otherwise `{ ok: false, error,
  writeState }`. `writeState` is `not-written`, `unknown` or `written`.
- Generic URL/path validation stays at 32 Ki code units. Clipboard text has a
  separate **4 Mi UTF-16-code-unit / 8 MiB** allocation budget, checked after
  terminal normalization. This is a provisional practical ceiling, not a
  native performance qualification. No truncation or automatic size bypass.
- Empty copy is explicitly rejected (`empty-text`), leaving existing formats
  untouched. `desktop.clearClipboard()` is the intentional, acknowledged clear
  operation; ordinary no-selection UI gestures never call it.
- Native throws/IPC rejection are ambiguous; failed readback is already written.
  Neither permits a second writer. Only definite pre-write unavailability may
  use a browser/legacy fallback, and only while its original target still owns
  input. Validation errors do not bypass the size/security policy.
- Copy buttons wait for the final result; global failures are visible in the
  application alert. The `studio:clipboard-result` event contains only final
  outcome codes, never clipboard contents. Chromium owns cut atomically; the
  app does not race a second async write against native cut/deletion.
- Terminal selections retain existing frame-cleaning and Windows CRLF policy;
  other UI text is unchanged. Paste event text/Unicode/newlines is passed to
  xterm unchanged (xterm owns terminal paste encoding). One capture listener
  owns each native paste event. Event-identity guarding replaces the 40ms
  text-based heuristic: separate identical actions are not suppressed.
- Async right-click/image reads are bound to the mounted terminal, input target
  and focus generation. Focus transfer, window blur and unmount invalidate them
  even if focus returns. JS-dispatched untrusted paste events remain rejected.
  Image/file reads still sample the current OS clipboard asynchronously; they
  do not claim an immutable snapshot of the triggering clipboard event.

The retained `manifest.json` contains source HEAD/dirty status, tested source
hashes, lockfile/harness hashes, executable and app.asar SHA-256, OS/Node/CDP/app
runtime identity, configuration/seed, dynamic identities, outcomes and scope
exceptions. The source HEAD is the checkout identity, not a claim that an old
artifact was built from that commit. Profile and scratch data are removed after
owned-process cleanup. Raw renderer/desktop output, commands, clipboard content
and credentials are not retained.

## Reproductions and remaining blocker scope

An **explicit opt-in source reproduction** preserves C1 without making the
mandatory harness suite red before WP01:

```powershell
npm run test:desktop:smoke -- --baseline-clipboard
```

It checks 32,768/32,769 code-unit synthetic strings using `isClipboardText`;
rejection produces a failed component-only result/exit 1. It never accesses the
OS clipboard. A future pass of this boundary does not close native clipboard
qualification.

| Finding / boundary | WP00 evidence | Still required |
| --- | --- | --- |
| C1 clipboard | Source boundary + acknowledged IPC fake tests; opt-in packaged clipboard scenario | Run packaged and physical paste/copy matrix on dedicated desktop |
| C2–C8 terminal/input | Delayed backend and owned child lifecycle fixtures only | PTY readiness, ordered input, safe retry, resource tests (WP02/03/12) |
| B1–B2 persistence | No production DB access | Synthetic historical databases and crash checkpoints (WP04) |
| B3–B11 backend/ACP | No provider launches | Controlled ACP/deferred automation and failure fixtures with their consuming tests (WP05–08/12) |
| U1–U13 UI | No production UI journeys | Target identity, accessibility, keyboard and continuity qualification (WP09–11) |
| B12 release | Exact-SHA build/test/coverage dependency before packaging/publication | Frozen staged dependencies, signed/native artifact evidence and full qualification (WP13) |

Downstream tests must retain these identities/contracts: clipboard action → one
acknowledged result; terminal session + generation + input sequence (OPEN is not
ready); ACP session + request + generation; cancellation requested/pending/final
status without promising rollback; one durable scheduler occurrence/admission;
retrievable persistence results and recoverable migration checkpoints.

The existing Release workflow now requires build, both coverage gates and harness
tests on its exact `github.sha`, on Windows and Linux, before either installer
job can run. This is WP00 containment, **not** a frozen release graph or a claim
that all blockers have passed. WP01 adds mandatory clipboard regressions; terminal
lifecycle, ACP and schema qualification remain with their later work packages.
