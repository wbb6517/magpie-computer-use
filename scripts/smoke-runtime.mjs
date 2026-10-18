import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { PROJECT_ROOT } from '../src/config.mjs';
import { NATIVE_TOOLS } from '../src/native-tools.mjs';

const record = { checkedAt: new Date().toISOString(), backend: 'embedded-gateway', externalLcuRequired: false,
  appControlAttempted: false, automaticallyApprovedApps: 0 };
const client = new Client({ name: 'magpie-computer-use-smoke', version: '0.5.0' }, { capabilities: { elicitation: { form: {} } } });
client.setRequestHandler(ElicitRequestSchema, async () => { record.approvalsCancelled = (record.approvalsCancelled || 0) + 1; return { action: 'cancel' }; });
const transport = new StdioClientTransport({ command: process.execPath,
  args: [path.join(PROJECT_ROOT, 'bin/magpie-computer-use.mjs'), 'mcp'], cwd: PROJECT_ROOT, stderr: 'pipe' });
let diagnostic = '';
transport.stderr?.on('data', data => { diagnostic = (diagnostic + data.toString()).slice(-4000); });
try {
  await client.connect(transport, { timeout: 120000 });
  record.server = client.getServerVersion();
  const listed = await client.listTools();
  record.tools = listed.tools.map(tool => tool.name);
  assert.deepEqual(record.tools, NATIVE_TOOLS.map(tool => tool.name));
  const result = await client.callTool({ name: 'list_apps', arguments: {} }, undefined, { timeout: 120000 });
  assert.notEqual(result.isError, true, 'Native list_apps must pass process authentication');
  const text = result.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? '';
  assert.match(text, /com\.[a-zA-Z]|displayName|AppInfo|apps:/, 'Original runtime must return an app inventory');
  record.nativeDiscovery = { passed: true, textCharacters: text.length };
  record.passed = true;
} catch (error) {
  record.passed = false; record.error = error.message; record.diagnostic = diagnostic;
  process.exitCode = 1;
} finally { await client.close().catch(() => {}); }
// Keep a compact proof in the docs, without cached runtime instructions or app inventory.
await fs.writeFile(path.join(PROJECT_ROOT, 'docs/verification.json'), JSON.stringify(record, null, 2) + '\n');
process.stdout.write(JSON.stringify(record, null, 2) + '\n');
