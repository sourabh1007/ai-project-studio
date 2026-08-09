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
