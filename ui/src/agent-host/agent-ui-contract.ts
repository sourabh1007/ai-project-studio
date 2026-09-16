import type { ComponentType, LazyExoticComponent } from 'react';
import type { Feature } from '../lib/types.js';

/**
 * Host services injected into an agent's workspace-tab component. An agent
 * renders only through this context — it never reaches into app globals — so a
 * broken agent can be isolated behind an error boundary without touching core.
 */
export interface AgentUiContext {
  /** The feature this agent instance is attached to. */
  feature: Feature;
  /** The persisted attachment id backing this tab. */
  attachmentId: string;
  /** The agent id (matches the backend manifest id). */
  agentId: string;
}

export interface AgentUiProps {
  ctx: AgentUiContext;
}

/**
 * A frontend agent contributed to the UI registry. Mirrors the backend
 * manifest fields the shell needs to gate attach affordances and render tabs.
 */
export interface AgentUiModule {
  id: string;
  title: string;
  /** Icon id mirrored from the backend manifest. */
  icon: string;
  allowMultiplePerFeature: boolean;
  component: LazyExoticComponent<ComponentType<AgentUiProps>>;
}
