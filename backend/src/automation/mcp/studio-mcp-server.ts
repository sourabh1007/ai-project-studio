import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  createStudioApiClient,
  registerStudioMcpTools,
} from './studio-mcp-tools.js';
import { watchForParentExit } from './studio-mcp-lifecycle.js';
import { checkStudioApiAvailability, studioMcpMissingConfigMessage } from './studio-mcp-startup.js';

const apiBase = process.env.STUDIO_API_BASE;
const controlToken = process.env.STUDIO_CONTROL_TOKEN;

if (!apiBase || !controlToken) {
  process.stderr.write(`${studioMcpMissingConfigMessage()}\n`);
  process.exit(0);
}

const availability = await checkStudioApiAvailability({
  apiBase,
  controlToken,
  fetch,
  timeoutMs: 1_000,
});
if (!availability.ok) {
  process.stderr.write(`${availability.message}\n`);
  process.exit(0);
}

// Exit the moment the owning CLI session's stdio pipe closes; otherwise this
// process leaks forever with no parent left to talk to (see
// studio-mcp-lifecycle.ts for why the MCP SDK doesn't already handle this).
watchForParentExit(process.stdin, () => process.exit(0));

const server = new McpServer({
  name: 'ai-project-studio',
  version: '0.1.0',
});

registerStudioMcpTools(
  server,
  createStudioApiClient({
    baseUrl: apiBase,
    controlToken,
    fetch,
  }),
);

await server.connect(new StdioServerTransport());
