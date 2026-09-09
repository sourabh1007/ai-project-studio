import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  createStudioApiClient,
  registerStudioMcpTools,
} from './studio-mcp-tools.js';
import { watchForParentExit } from './studio-mcp-lifecycle.js';

const apiBase = process.env.STUDIO_API_BASE;
const controlToken = process.env.STUDIO_CONTROL_TOKEN;

if (!apiBase || !controlToken) {
  throw new Error('STUDIO_API_BASE and STUDIO_CONTROL_TOKEN are required');
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

