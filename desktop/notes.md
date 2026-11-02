# Notes

## AI Project Studio Overview

AI Project Studio is an Electron desktop app that wraps AI coding CLIs (like GitHub Copilot and Agency) in an IDE-style workspace organized by **Feature → Session**.

### Monorepo Structure

- `backend/`: Express API with ports-and-adapters architecture in TypeScript.
- `ui/`: React + Vite frontend.
- `desktop/`: Electron shell that starts backend services and loads the UI.

### Key Architecture Notes

- Backend wiring/composition root is `backend/src/main.ts`.
- Core provider abstraction is `IAIProvider` with adapters for specific tools.
- Live usage/session updates flow through the backend event bus and are streamed to the UI.

### Important Development Constraints

- Backend enforces **100% test coverage**.
- Keep domain logic pure and push I/O to adapters.
- Add module config in each module's `config.ts` (`NAMESPACE`, zod schema, defaults).
- Avoid coupling core logic to a specific provider implementation.

### Useful Commands

```bash
npm run build
npm run test:coverage --workspace backend
npm run test:coverage --workspace ui
```

### Native desktop safety and qualification

- Electron is pinned to **44.9.3** in both `package.json` and the builder config.
  The official [support policy](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)
  supports the latest three stable majors; npm's `latest` tag was an alpha when
  selected, so it was not used. Electron 44 requires macOS 13+ and drops all
  32-bit platforms ([breaking changes](https://www.electronjs.org/docs/latest/breaking-changes#breaking-api-changes-440)).
  Windows targets remain 64-bit Windows 10+. These are upstream requirements,
  **not** evidence that this checkout was executed on every supported OS.
- The backend runtime is pinned to Node **24.20.0**. System Node must match the
  native addon's Node 24 ABI and meet that minimum. `CW_NODE_BIN` also rejects
  older versions; an explicitly selected newer major still requires the
  operator to supply a compatible native addon.
- Electron 44's [clipboard API](https://github.com/electron/electron/blob/v44.9.3/docs/api/clipboard.md)
  is asynchronous. Clipboard items expose lazy payloads; file-list payloads are
  bounded and read before images. PNG bytes and IHDR dimensions are bounded
  before the app's `nativeImage` decode, with a concurrent-read guard and a
  250 ms throttle. This does not claim to bound OS clipboard extraction work.
  The legacy synchronous path cannot preflight native decode; it checks storage
  quota first. CF_HDROP parsing validates DROPFILES offsets, UTF-16 alignment,
  double terminators and limits. Non-ASCII legacy ANSI paths are explicitly
  refused rather than decoded using a guessed system codepage; native Electron
  44 URI lists avoid that ambiguity.
- On macOS, copy/clear await native completion without mandatory programmatic
  readback. A rejected write is still an error. Explicit user paste reads remain
  subject to OS permission and errors are propagated, not presented as empty
  successful reads. No OS privacy rollout timing is assumed.
- Windows automatic installation requires an exact HTTPS release asset plus
  `candidate-win32-<arch>.json` from this repository's release. The candidate must
  have `schemaVersion: 1`, `qualification: "passed"`, the exact version/platform/
  architecture, and one matching artifact name with SHA-256 and byte length.
  **The candidate writer deliberately emits `pending`; publishing that file does
  not qualify a release.** Qualification is a separate release-owner decision.
- Packaged `updateTrust.requireAuthenticode` defaults to `true`. A signed
  candidate additionally needs `signatureVerification: "passed"` and must pass
  local Authenticode validation against `updateTrust.signerThumbprints` or exact
  certificate `signerSubjects` pinned in
  the installed app's package metadata, never signer identities supplied by the
  downloaded manifest. The committed pin list is empty: automatic installation
  stays unavailable until a release owner configures real trusted identities.
  Exact full subject pins can accommodate Azure Trusted Signing's rotating leaf
  certificates; a subject match still requires a valid OS-verified signature.
  No certificate, credential or signing result is invented.
- Failed evidence, hash, signature, download or backend-shutdown checks never
  launch an installer. Downloads use private unique `userData/updates` folders;
  the injected runner is invoked only after verification and cooperative
  backend shutdown. A spawn receipt is awaited before scheduling quit. Ordinary
  app quit never installs. macOS remains a guided release-page flow.

Validation uses Node tests with injected clipboard, downloads, signature and
installer boundaries. It does not touch the real clipboard, show/focus windows,
run installers or establish native macOS/packaged-platform qualification.
