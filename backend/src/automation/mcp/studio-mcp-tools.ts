import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const STUDIO_CONTROL_TOKEN_HEADER = 'x-studio-control-token';

export interface StudioApiRequest {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
}

export interface StudioApiClient {
  request(input: StudioApiRequest): Promise<unknown>;
}

export interface StudioApiClientDeps {
  baseUrl: string;
  controlToken: string;
  fetch: typeof fetch;
}

export interface ToolRegistrar {
  registerTool(
    name: string,
    config: {
      description: string;
      inputSchema?: Record<string, z.ZodTypeAny>;
    },
    cb: (args: Record<string, unknown>) => Promise<CallToolResult>,
  ): unknown;
}

const originSchema = z.object({
  sessionId: z.string().nullable().optional(),
  featureId: z.string().nullable().optional(),
});

const plannedStepSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(['pending', 'active', 'done', 'skipped']),
  detail: z.string().nullable(),
});

const checkSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('shell'),
    command: z.string().describe('Shell command to run'),
    cwd: z.string().optional(),
  }),
  z.object({
    type: z.literal('http'),
    url: z.string().describe('URL to poll'),
    method: z.enum(['GET', 'POST']).optional(),
  }),
  z.object({
    type: z.literal('ai'),
    prompt: z.string().describe('Prompt for an AI check run'),
    cwd: z.string().optional(),
  }),
  z.object({
    type: z.literal('ci-pipeline'),
    provider: z.enum(['github', 'azure']),
    repo: z.string(),
    ref: z.string().optional(),
    pipeline: z.string().optional(),
  }),
]);

const conditionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('always') }),
  z.object({ type: z.literal('exit-code'), equals: z.number() }),
  z.object({ type: z.literal('status-equals'), value: z.string() }),
  z.object({ type: z.literal('conclusion-equals'), value: z.string() }),
  z.object({ type: z.literal('text-contains'), value: z.string() }),
  z.object({ type: z.literal('ai-verdict') }),
]);

const actionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('metasession'),
    prompt: z.string(),
    cwd: z.string().optional(),
  }),
  z.object({
    type: z.literal('subagent'),
    task: z.string(),
    prompt: z.string(),
    cwd: z.string().optional(),
  }),
  z.object({
    type: z.literal('report'),
    prompt: z.string(),
    cwd: z.string().optional(),
  }),
  z.object({
    type: z.literal('command'),
    command: z.string(),
    cwd: z.string().optional(),
  }),
]);

const createMonitorSchema = {
  name: z.string(),
  mode: z.enum(['short', 'long']),
  origin: originSchema.optional(),
  check: checkSchema,
  condition: conditionSchema,
  action: actionSchema,
  intervalMs: z.number().optional(),
  maxRuns: z.number().nullable().optional(),
  plannedSteps: z.array(plannedStepSchema).optional(),
};

const CREATE_MONITOR_DESCRIPTION = [
  'Create an AI Project Studio monitor (automation) that periodically runs a',
  'check, evaluates a condition, and fires an action. Use mode "short" to run',
  'once then stop, or "long" to keep polling.',
  '',
  'IMPORTANT — the Studio background engine owns the polling once this tool',
  'returns. After a successful create_monitor call, the engine runs the check',
  'on the interval and fires the action itself, and it keeps running even after',
  'this session ends. Do NOT also start your own repeating loop (for example a',
  '`/every` schedule) and do NOT keep polling the resource yourself — that',
  'creates a duplicate, uncontrollable monitor. Call create_monitor exactly',
  'once, then report that monitoring is registered and stop. The user',
  'pauses/resumes/cancels the monitor from the Automations panel, and those',
  'controls only govern this engine-run monitor, so it must be the only one.',
  '',
  'check (choose exactly one type):',
  '- { "type": "shell", "command": "gh run list ...", "cwd"?: "..." }',
  '- { "type": "http", "url": "https://api...", "method"?: "GET"|"POST" }',
  '- { "type": "ai", "prompt": "Check whether ..." , "cwd"?: "..." }',
  '- { "type": "ci-pipeline", "provider": "github"|"azure", "repo": "owner/name",',
  '    "ref"?: "main", "pipeline"?: "..." }',
  '',
  'condition (choose one): { "type": "always" } | { "type": "exit-code",',
  '"equals": 0 } | { "type": "status-equals", "value": "completed" } |',
  '{ "type": "conclusion-equals", "value": "success" } | { "type":',
  '"text-contains", "value": "..." } | { "type": "ai-verdict" }',
  '',
  'action (choose one): { "type": "metasession", "prompt": "..." } |',
  '{ "type": "subagent", "task": "...", "prompt": "..." } | { "type": "report",',
  '"prompt": "..." } | { "type": "command", "command": "..." }',
  '',
  'For an Azure DevOps release/pipeline that is not a GitHub repo, use an',
  '"http" check polling the Azure DevOps REST API (with a text-contains or',
  'ai-verdict condition), or a "shell" check running the "az" CLI. The',
  'ci-pipeline check with provider "azure" requires an Azure Pipelines repo,',
  'not a classic release URL.',
].join('\n');

const progressSchema = {
  id: z.string(),
  progress: z.string(),
};

const plannedStepsSchema = {
  automationId: z.string(),
  steps: z.array(plannedStepSchema),
};

const registerSubagentSchema = {
  automationId: z.string(),
  task: z.string(),
  origin: originSchema,
};

export function createStudioApiClient(
  deps: StudioApiClientDeps,
): StudioApiClient {
  const baseUrl = deps.baseUrl.replace(/\/+$/, '');
  return {
    async request(input) {
      const hasBody = input.body !== undefined;
      const response = await deps.fetch(`${baseUrl}${input.path}`, {
        method: input.method,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          [STUDIO_CONTROL_TOKEN_HEADER]: deps.controlToken,
        },
        body: hasBody ? JSON.stringify(input.body) : undefined,
      });
      const text = await response.text();
      const payload = text ? (JSON.parse(text) as unknown) : null;
      if (!response.ok) {
        throw new Error(`Studio API ${response.status}: ${text}`);
      }
      return payload;
    },
  };
}

export function asToolResult(value: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
  };
}

export function createStudioMcpToolHandlers(api: StudioApiClient) {
  return {
    createMonitor: (input: z.infer<z.ZodObject<typeof createMonitorSchema>>) =>
      api.request({ method: 'POST', path: '/automations', body: input }),
    updateMonitorProgress: (input: z.infer<z.ZodObject<typeof progressSchema>>) =>
      api.request({
        method: 'POST',
        path: `/automations/${encodeURIComponent(input.id)}/progress`,
        body: { progress: input.progress },
      }),
    setPlannedSteps: (
      input: z.infer<z.ZodObject<typeof plannedStepsSchema>>,
    ) =>
      api.request({
        method: 'POST',
        path: `/automations/${encodeURIComponent(input.automationId)}/planned-steps`,
        body: { steps: input.steps },
      }),
    registerSubagent: (
      input: z.infer<z.ZodObject<typeof registerSubagentSchema>>,
    ) =>
      api.request({
        method: 'POST',
        path: `/automations/${encodeURIComponent(input.automationId)}/subagents`,
        body: { task: input.task, origin: input.origin },
      }),
    updateSubagentProgress: (
      input: z.infer<z.ZodObject<typeof progressSchema>>,
    ) =>
      api.request({
        method: 'POST',
        path: `/subagents/${encodeURIComponent(input.id)}/progress`,
        body: { progress: input.progress },
      }),
    listAutomations: (_input: Record<string, never>) =>
      api.request({ method: 'GET', path: '/automations' }),
  };
}

export function registerStudioMcpTools(
  server: ToolRegistrar,
  api: StudioApiClient,
): void {
  const handlers = createStudioMcpToolHandlers(api);
  server.registerTool(
    'create_monitor',
    {
      description: CREATE_MONITOR_DESCRIPTION,
      inputSchema: createMonitorSchema,
    },
    async (args) =>
      asToolResult(
        await handlers.createMonitor(
          args as Parameters<typeof handlers.createMonitor>[0],
        ),
      ),
  );
  server.registerTool(
    'update_monitor_progress',
    {
      description: 'Update a monitor progress line.',
      inputSchema: progressSchema,
    },
    async (args) =>
      asToolResult(
        await handlers.updateMonitorProgress(
          args as Parameters<typeof handlers.updateMonitorProgress>[0],
        ),
      ),
  );
  server.registerTool(
    'set_planned_steps',
    {
      description: 'Replace a monitor planned-steps timeline.',
      inputSchema: plannedStepsSchema,
    },
    async (args) =>
      asToolResult(
        await handlers.setPlannedSteps(
          args as Parameters<typeof handlers.setPlannedSteps>[0],
        ),
      ),
  );
  server.registerTool(
    'register_subagent',
    {
      description: 'Register an externally-driven subagent for a monitor.',
      inputSchema: registerSubagentSchema,
    },
    async (args) =>
      asToolResult(
        await handlers.registerSubagent(
          args as Parameters<typeof handlers.registerSubagent>[0],
        ),
      ),
  );
  server.registerTool(
    'update_subagent_progress',
    {
      description: 'Update a subagent progress line.',
      inputSchema: progressSchema,
    },
    async (args) =>
      asToolResult(
        await handlers.updateSubagentProgress(
          args as Parameters<typeof handlers.updateSubagentProgress>[0],
        ),
      ),
  );
  server.registerTool(
    'list_automations',
    {
      description: 'List Studio automations and subagents.',
      inputSchema: {},
    },
    async () => asToolResult(await handlers.listAutomations({})),
  );
}
