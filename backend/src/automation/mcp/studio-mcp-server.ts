import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  createStudioApiClient,
  registerStudioMcpTools,
} from './studio-mcp-tools.js';

const apiBase = process.env.STUDIO_API_BASE;
const controlToken = process.env.STUDIO_CONTROL_TOKEN;

if (!apiBase || !controlToken) {
  throw new Error('STUDIO_API_BASE and STUDIO_CONTROL_TOKEN are required');
}

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
