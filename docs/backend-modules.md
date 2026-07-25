# Backend module reference

Every directory under `backend/src`. Each module owns its own `config.ts` (namespace + zod schema + defaults) where applicable, and exposes ports/contracts for testability.

## Work organization
| Module | Responsibility | Key files |
| --- | --- | --- |
| `feature/` | Core feature aggregate/service and feature-scoped work-summary contract. | `feature-service.ts`, `feature-contract.ts`, `feature-work-summary.ts` |
| `session/` | Session lifecycle: contracts, state machine, factory, launcher, reconciliation, transcript capture. | `session-launcher.ts`, `session-factory.ts`, `session-state-machine.ts`, `session-repo-port.ts` |
| `feature-tasks/` | Generate, parse, and run AI task plans attached to a feature; track progress. | `feature-tasks-service.ts`, `task-plan-runner.ts`, `task-plan-parser.ts` |
| `skills/` | Skill tagging + prompt composition (instruction blocks seeded into sessions). | `skills-service.ts`, `skill-prompt-composer.ts`, `skills-repo-port.ts` |

## Execution
| Module | Responsibility | Key files |
| --- | --- | --- |
| `provider/` | Provider abstraction + registry/resolver + concrete CLI adapters + CLI stores/process kernel. | `provider-contract.ts`, `provider-registry.ts`, `provider-resolver.ts`, `copilot-adapter/`, `agency-adapter/`, `cli-store/` |
| `terminal/` | PTY + WebSocket adapter for live interactive sessions; seeds skill instructions. | `terminal-manager.ts`, `terminal-session.ts`, `node-pty-spawner.ts`, `executable-resolver.ts` |
| `meta/` | Runs/parses "meta" sessions used for internal assistant tasks (summaries, plans). | `meta-runner.ts`, `meta-response-extractor.ts` |

## Telemetry & cost
| Module | Responsibility | Key files |
| --- | --- | --- |
| `usage/` | Ingests CLI/OTel usage: tail, dedup, normalize, and record to persistence; emits `usage.recorded`. | `usage-recorder.ts`, `cli-usage-tailer.ts`, `usage-normalizer.ts`, `usage-repo-port.ts` |
| `credit/` | Converts usage events to credits (AIC) via pluggable strategies. | `credit-calculator.ts`, `credit-strategies.ts` |
| `aggregation/` | Read-side rollup joining usage with session membership/timing into feature/workspace analytics. | `feature-analytics.ts`, `aggregation-contract.ts` |
| `ide-usage/` | Computes "IDE AI" overhead usage (meta-session usage) separately from feature work. | `ide-usage-service.ts` |

## Knowledge
| Module | Responsibility | Key files |
| --- | --- | --- |
| `summarizer/` | Feature/session transcript collection and summary prompt/response pipeline. | `summary-runner.ts`, `transcript-collector.ts`, `summary-store-port.ts` |
| `session-summary/` | Per-session summary generation and automatic triggering on session end. | `session-summary-runner.ts`, `session-summary-auto.ts` |
| `session-import/` | Imports provider-native past sessions into workspace sessions. | `session-import-service.ts` |
| `copilot-history/` | Reads the provider's historical session database for import/analysis. | `copilot-history-reader.ts`, `copilot-history-db.ts` |

## Platform
| Module | Responsibility | Key files |
| --- | --- | --- |
| `kernel/` | Shared primitives: event bus, clock, ids, logger, typed error classes. | `event-bus.ts`, `clock.ts`, `logger.ts`, `error-types.ts` |
| `config/` | Config infrastructure: schema registry, env loader, validation, secret resolution. | `config-schema-registry.ts`, `config-loader.ts`, `config-validator.ts` |
| `persistence/` | SQLite connection, schema, and repos for every persisted aggregate. | `db/connection.ts`, `db/schema.ts`, `*-repo.ts` |
| `workspace/` | Workspace admin/path utilities and migration helpers. | `workspace-admin-service.ts`, `workspace-paths.ts` |
| `api/` | HTTP/SSE boundary: Express adapter, route table, controllers, validation, stream forwarding. | `routes.ts`, `express-adapter.ts`, `usage-stream.ts`, `*-controller.ts` |

## Composition root
`main.ts` — registers config schemas, builds deps, wires providers/services/repos/routes, and starts the server. Adding a module means wiring it here.
