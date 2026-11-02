# Packaged desktop regression foundation (WP00/WP01)

This is a **shell smoke**, not native input or production-readiness certification.
It starts the actual packaged shell, its BrowserWindow and preload, but substitutes
a synthetic HTTP backend/document. It checks document identity and acknowledged
version IPC. It never imports the production backend or renders the production UI.

## Commands

From the repository root (Node ≥24.20.0 and existing npm dependencies):

```powershell
npm run test:desktop:harness
npm run test:desktop:smoke -- --exe "C:\candidate\AI Project Studio.exe"
npm run test:desktop:smoke -- --ready-delay-ms 500 --timeout-ms 30000 --seed 42
npm run test:desktop:smoke -- --ready-delay-ms 5000 --timeout-ms 60000
```

`--exe` or `CW_TEST_EXE` selects an **unpacked/installed executable**, not an
installer. The default is `desktop/release/win-unpacked/AI Project Studio.exe`.
On macOS pass the executable inside `Contents/MacOS`; Linux requires an unpacked
executable with adjacent `resources/app.asar`. Non-Windows packaged trials are
not qualified by WP00's Windows development run.

`--out` selects a results parent (default `desktop/test-results`, ignored by git).
Each invocation creates a fresh child directory; never supply a live profile as
a fixture. `--timeout-ms` is bounded to 1–60 seconds, delayed readiness to 0–5
seconds. Source/package preflight and hashing precede launch. Renderer runtime
initialization/readiness probes use up to 15 seconds within the startup budget;
ordinary CDP operations retain their five-second limits. Readiness diagnostics
distinguish renderer attachment, document readiness and version acknowledgement.
Cleanup has separate bounded waits and asynchronously retries transient Windows
profile locks. Removal failures still fail the trial; only the manifest is
retained after successful cleanup. Elapsed time includes cleanup. The seed is
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
  prefers the installed PowerShell 7 host, whose in-process compiler avoids the
  legacy .NET Framework compiler's startup delay in isolated CI environments.
  Windows PowerShell remains the fallback when PowerShell 7 is absent. The helper
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

- Desktop pins **Electron 44.9.3** (64-bit only; macOS 13+). Electron 44's
  asynchronous/lazy clipboard items require awaiting native reads and bounding
  app-owned materialization. PNG byte/dimension checks before the app's own image
  decode do not guarantee bounded OS-side extraction or permission-free reads.
- Native Windows file lists use Electron 44's `text/uri-list` mapping to
  `CF_HDROP`. The legacy raw-buffer fallback accepts validated UTF-16 and ASCII
  ANSI paths; unsupported non-ASCII ANSI is rejected rather than decoded using
  a guessed codepage.
- macOS Edit menu copy/paste entries use Electron's native `copy`, `paste` and
  `pasteAndMatchStyle` roles, including platform Command key equivalents and
  focused-responder routing. Windows/Linux retain accelerator-free custom menu
  clicks so keyboard paste does not gain a second menu dispatcher. Terminal
  keyboard paste never reads the clipboard itself: the trusted editing event
  remains the single paste owner. Simulated menu/renderer tests do not qualify
  installed macOS keyboard behavior.
- `desktop.copyText(text)` returns `Promise<ClipboardResult>`: `{ ok: true }`
  after a native write and supported verification; otherwise `{ ok: false,
  error, writeState }`. macOS deliberately skips a programmatic post-write
  readback to avoid making copy require paste permission. Native rejected
  writes still fail; user-triggered paste reads remain permission-dependent.
  `writeState` is `not-written`, `unknown` or `written`.
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
  owns each native paste event. Event identity rejects repeated handling of the
  same event, including delayed repeated handling. Separate trusted events are
  accepted even when their contents/timestamps match. The old 50ms signature
  heuristic dropped deliberate identical pastes and could not identify delayed
  host duplicates. There is no content/timing debounce or retained signature.
- Async right-click/image reads are bound to the mounted terminal, input target
  and focus generation. Focus transfer, window blur and unmount invalidate them
  even if focus returns. JS-dispatched untrusted paste events remain rejected.
  Image/file reads still sample the current OS clipboard asynchronously; they
  do not claim an immutable snapshot of the triggering clipboard event.

### Windows terminal input/geometry investigation

Two deterministic renderer regressions are covered, not physical symptom closure:

- Changing terminal font/size previously called `fit.fit()` directly: a mocked
  80×24 → 64×18 measurement changed xterm without sending a PTY resize. It also
  bypassed selection, drag and replay guards. Appearance changes now request the
  shared guarded fit/resize/repaint path, with bounded measurement retries.
  `document.fonts.ready`/`loadingdone` retry delayed metrics through that path;
  display-scale monitoring still uses the existing settled resize mechanism.
- Two separate handler-fixture trusted events with identical text and timestamp
  were reduced to one payload by the 50ms signature heuristic. Event identity now
  prevents repeated handling without dropping intentional repeated pastes.
  A fixture marked `isTrusted: true` is **not** a physical Windows/macOS event.
  Distinct duplicate events from one physical gesture remain unverified; their
  contents/timing alone do not establish ownership or intent.

For intermittent Windows duplication, use the production terminal's **Session
diagnostics → Record terminal input metadata (opt-in)**. Return focus to the
terminal after enabling. No tracing is enabled by default. The per-view recorder
keeps only the latest **128** records in memory: relative monotonic milliseconds,
operation IDs, source/trust, focus epoch, terminal generation, byte counts,
transport sequence numbers, grid size and composition/paste-input flags. It
never stores clipboard/prompt text, paths, content hashes or terminal output;
there is no telemetry, persistence or automatic export. Disable to erase; closing
the view also discards it. Reconnect observations can remain in the bounded trace.
Operation IDs identify event objects/handler operations, **not physical gestures**;
buffered transport frames can have a null operation ID.

On a dedicated Windows desktop, with synthetic markers and an installed candidate:

1. Record candidate/version, keyboard/IME, display scale and provider CLI version.
   Perform exactly one physical Ctrl+V, then a separate Enter. Compare accepted
   `paste-event`, `paste-call`, `xterm-data`, and `transport-input` byte counts/
   sequence IDs (large pastes legitimately use multiple transport frames).
   `submit-key` is separate. Test Edit menu paste and right-click independently.
2. Repeat two deliberate identical pastes, including fast pairs. Same operation
   ID plus `duplicate-event` identifies repeated handler invocation; two accepted
   event IDs do **not** prove two user gestures. If DOM `input`/`beforeinput`
   appears after the owned paste, note trust, composition/fromPaste flags and
   sizes to locate any additional input path. Do not infer a fix from timing.
3. Exercise LF/CRLF, emoji/wide/combining characters, >64 KiB UTF-8, IME
   composition/commit, modal focus, tab changes, app blur/refocus, pending native
   image/right-click reads and reconnect. No stale async read may reach a new
   owner/generation. Repeat font changes, resize and monitor/DPI moves while
   composing; compare renderer and PTY resize metadata.
4. Retain metadata/counts only, then disable recording. Never capture real
   prompts, clipboard content or file paths for this investigation.

Handler-fixture tests verify one payload, deliberate repeats, separate Enter,
large UTF-8 delivery, multiline/IME passthrough, capture cancellation, async
ownership and replay/selection/drag/font guards. They cannot reproduce native
default insertion or certify xterm/ConPTY/provider rendering on real displays.
The intermittent Windows native duplicate cause and physical overlapping
composer symptom remain open until this production path is exercised. No actual
Mac was available; macOS physical qualification below remains required.

### Required macOS physical-input qualification

Run on a dedicated Mac with the candidate installed app and production UI/backend,
not the synthetic smoke document. Record candidate SHA/artifact hash, macOS and
Electron versions, architecture, keyboard/IME, display scale, provider CLI version
and outcomes. Use synthetic prompt markers only; retain counts, timing and
geometry, not prompts, clipboard contents, file paths or terminal transcripts.

1. Verify Edit menu Copy/Paste/Paste and Match Style have native Command key
   equivalents. Test physical Cmd+C/Cmd+V and menu clicks in a normal input,
   textarea, modal field and a focused terminal; no terminal input may reach an
   editable field's paste destination or vice versa.
2. At a ready interactive CLI prompt, test ASCII, CRLF/LF multiline, emoji,
   combining/wide characters and a paste larger than 64 KiB. One action inserts
   one payload; paste itself must not submit. A separate Enter submits once.
   Repeat identical deliberate pastes, including fast pairs, and compare intended
   actions against observed insertions. Check Ctrl+C still interrupts without a
   selection, Cmd+C copies a selection and explicit Shift variants do not add a
   second paste owner. Verify Cmd+Option+Shift+V through the native menu role.
3. Paste/copy during Japanese/Chinese IME composition and immediately after
   committing it. Switch terminal tabs, open/close a modal, focus another field,
   blur/refocus the app and reconnect during a pending image/right-click read:
   no stale paste, redirected copy fallback or focus theft is allowed.
4. Resize while pasting/typing; change font size/family and theme; move between
   Retina/non-Retina displays and sleep/resume. Input counts must stay unchanged,
   final PTY and xterm geometry must agree, and the composer must remain aligned
   without lost text. Reconnect after acknowledged and unacknowledged input:
   uncertain input must not replay, and a visible notice must explain discards.
5. Check text, image and copied-file clipboard formats separately; failed or
   cancelled attachment reads must never fall back to stale text or auto-retry.
   Repeat keyboard/menu text cases in a supported browser on macOS to separate
   Electron menu routing from browser input behavior.

A source-level platform/menu regression pass and the opt-in clipboard IPC smoke
are prerequisites, not substitutes for this evidence. CI/release builds on macOS
alone do not establish physical keyboard, native focus or interactive PTY behavior.

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
