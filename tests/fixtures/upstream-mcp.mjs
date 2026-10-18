// Deterministic MCP fixture. It never loads LCU or accesses any desktop surface.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { imageResult, tools } from './lcu-client.mjs';
const server = new Server({ name: 'original-runtime-fixture', version: '1' }, {
  capabilities: { tools: {} }, instructions: 'fixture original initialization instructions',
});
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...tools,
  { name: 'turn_ended', inputSchema: { type: 'object' } }] }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args = {}, _meta: metadata } = request.params;
  if (name === 'turn_ended') return { content: [{ type: 'text', text: 'cleaned up' }] };
  if (args.code === 'progress') {
    await server.notification({ method: 'notifications/progress', params: {
      progressToken: metadata.progressToken, progress: 1, total: 2, message: 'real upstream progress',
    } });
  }
  if (args.code === 'approval') {
    const response = await server.elicitInput({ mode: 'form', message: 'Original app approval',
      requestedSchema: { type: 'object', properties: {} },
      _meta: { connector_id: 'computer-use', codex_approval_kind: 'mcp_tool_call',
        tool_params: { app: args.app ?? 'com.apple.finder' }, persist: ['session', 'always'] },
    });
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  }
  return imageResult;
});
await server.connect(new StdioServerTransport());
