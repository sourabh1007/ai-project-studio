import type { AgentUiModule } from './agent-ui-contract.js';
import { reviewBoardModule } from '../agents/review-board/review-board-module.js';
import { newTaskModule } from '../agents/new-task/new-task-module.js';
import { bugBashModule } from '../agents/bug-bash/bug-bash-module.js';

/**
 * The frontend agent registry. Adding an agent means appending its module
 * here — nothing else in the shell changes.
 */
export const AGENT_MODULES: readonly AgentUiModule[] = [
  reviewBoardModule,
  newTaskModule,
  bugBashModule,
];

/** The UI module for an agent id, or undefined when none is registered. */
export function getAgentModule(agentId: string): AgentUiModule | undefined {
  return AGENT_MODULES.find((module) => module.id === agentId);
}
