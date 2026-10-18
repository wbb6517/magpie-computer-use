import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
process.env.LCU_DIAGNOSTIC_LOG = '0';

import { runBridge, hostIdentity } from '../src/bridge.mjs';
import { fixtureFactory, instructions, tools, imageResult, errorResult } from './fixtures/lcu-client.mjs';

class PeerTransport {
  constructor(toServer, fromServer) { this.toServer = toServer; this.fromServer = fromServer; this.pending = ''; }
  async start() {
    this.fromServer.setEncoding('utf8');
    this.fromServer.on('data', chunk => {
      this.pending += chunk;
      for (;;) {
        const index = this.pending.indexOf('\n');
        if (index < 0) break;
        const line = this.pending.slice(0, index);
        this.pending = this.pending.slice(index + 1);
        if (line.trim()) this.onmessage?.(JSON.parse(line));
      }
    });
  }
  async send(message) { this.toServer.write(`${JSON.stringify(message)}\n`); }
  async close() { this.toServer.end(); this.onclose?.(); }
}

async function harness(t, { createClient, fixtureOptions, elicitation, capabilities = { elicitation: {} }, ...options } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const errorOutput = new PassThrough();
  let errors = '';
  errorOutput.on('data', data => { errors += data.toString(); });
  const events = [];
  const bridge = await runBridge({ runtimeCommand: ['fixture-never-real-runtime'],
    input, output, errorOutput, idleTimeoutMs: 0, toolSurface: 'javascript', createClient: createClient === null ? undefined : createClient ?? fixtureFactory(events, fixtureOptions), ...options });
  const peer = new Client({ name: 'test-host', version: '1' }, { capabilities });
  if (elicitation) peer.setRequestHandler(ElicitRequestSchema, elicitation);
  await peer.connect(new PeerTransport(input, output));
  t.after(async () => { await bridge.close('test'); await peer.close(); });
  return { peer, bridge, events, input, errors: () => errors };
}

async function until(predicate, message = 'condition did not become true') {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(5); }
  assert.fail(message);
}

test('forwards original instructions, public descriptors, PNG bytes and original isError', async t => {
  const { peer, events } = await harness(t);
  assert.equal(peer.getInstructions(), instructions);
  assert.deepEqual((await peer.listTools()).tools, tools);
  assert.deepEqual(await peer.callTool({ name: 'js', arguments: { code: 'image' } }), imageResult);
  assert.deepEqual(await peer.callTool({ name: 'js', arguments: { code: 'fail' } }), errorResult);
  assert.equal(events.filter(event => event.event === 'turnEnded').length, 0, 'one call is not a user turn');
});

test('uses connection identity unless real request metadata supplies host identity; args cannot choose it', async t => {
  const { peer, bridge, events } = await harness(t);
  await peer.callTool({ name: 'js', arguments: { code: 'image', sessionId: 'model-forgery',
    turnId: 'model-forgery', _meta: { 'x-codex-turn-metadata': { session_id: 'fake', turn_id: 'fake' } } } });
  assert.equal(events[1].sessionId, bridge.connectionIdentity.sessionId);
  assert.match(events[1].sessionId, /^magpie-mcp-/);
  await peer.callTool({ name: 'js', arguments: {}, _meta: {
    'x-codex-turn-metadata': { session_id: 'host-session', turn_id: 'host-turn', call_id: 'host-call' },
  } });
  assert.deepEqual({ sessionId: events[2].sessionId, turnId: events[2].turnId, toolCallId: events[2].toolCallId },
    { sessionId: 'host-session', turnId: 'host-turn', toolCallId: 'host-call' });
  await bridge.close('test');
  assert.equal(events.filter(event => event.event === 'turnEnded').length, 2);
  assert.equal(events.at(-1).event, 'close');
});

test('rejects malformed host metadata and never exposes host-only tools', async t => {
  const { peer, events } = await harness(t);
  await assert.rejects(peer.callTool({ name: 'js', arguments: {},
    _meta: { 'x-codex-turn-metadata': { session_id: 'host-only' } } }), /metadata requires/);
  await assert.rejects(peer.callTool({ name: 'turn_ended', arguments: {} }), /Unknown Computer Use tool/);
  assert.equal(events.filter(event => event.event === 'call').length, 0);
  assert.throws(() => hostIdentity({ 'x-codex-turn-metadata': 'invalid' }, {}), /Invalid host turn metadata/);
});

test('forwards genuine human approval including requested scope and persistence', async t => {
  let received;
  const actual = { action: 'accept', content: {}, _meta: { persist: 'session' } };
  const { peer, events } = await harness(t, { elicitation: async request => { received = request.params; return actual; } });
  await peer.callTool({ name: 'js', arguments: { code: 'approval' } });
  assert.equal(received.message, 'Allow the original app?');
  assert.deepEqual(received._meta.persist, ['session', 'always']);
  assert.equal(received._meta.tool_params.app, 'com.apple.finder');
  assert.deepEqual(events.find(event => event.event === 'approval').response, actual);
});

test('cancels when downstream cannot elicit instead of allowing silently', async t => {
  const { peer, events } = await harness(t, { capabilities: {} });
  await peer.callTool({ name: 'js', arguments: { code: 'approval' } });
  assert.deepEqual(events.find(event => event.event === 'approval').response, { action: 'cancel' });
});

test('never asks the model or host to approve controlling magpie itself', async t => {
  let asked = 0;
  const { peer, events } = await harness(t, { fixtureOptions: { app: 'COM.YETONE.MAGPIE' },
    elicitation: async () => { asked++; return { action: 'accept', content: {} }; } });
  await peer.callTool({ name: 'js', arguments: { code: 'approval' } });
  assert.equal(asked, 0);
  assert.deepEqual(events.find(event => event.event === 'approval').response, { action: 'decline' });
});

test('forwards progress under the downstream request token', async t => {
  const { peer } = await harness(t);
  const progress = [];
  await peer.callTool({ name: 'js', arguments: { code: 'progress' } }, undefined,
    { onprogress: update => progress.push(update) });
  assert.equal(progress.length, 1);
  assert.equal(progress[0].message, 'original progress');
  assert.equal(progress[0].progress, 1);
  assert.notEqual(progress[0].progressToken, 'upstream-private-token');
});

test('pauses the request deadline while a person decides', async t => {
  const { peer, events } = await harness(t, { requestTimeoutMs: 30,
    elicitation: async () => { await delay(90); return { action: 'decline' }; } });
  await peer.callTool({ name: 'js', arguments: { code: 'approval' } });
  assert.deepEqual(events.find(event => event.event === 'approval').response, { action: 'decline' });
});

test('cancellation reaches upstream, cleans that context, and renews a connection context', async t => {
  const { peer, bridge, events } = await harness(t);
  const before = bridge.connectionIdentity;
  const controller = new AbortController();
  const pending = peer.callTool({ name: 'js', arguments: { code: 'hang' } }, undefined, { signal: controller.signal });
  await until(() => events.some(event => event.event === 'call'));
  controller.abort(new Error('user interrupted'));
  await assert.rejects(pending, /user interrupted/);
  await until(() => events.some(event => event.event === 'turnEnded'));
  await until(() => bridge.connectionIdentity.turnId !== before.turnId);
  assert.equal(events.find(event => event.event === 'turnEnded').turnId, before.turnId);
  await peer.callTool({ name: 'js', arguments: {} });
  assert.notEqual(events.filter(event => event.event === 'call').at(-1).turnId, before.turnId);
});

test('EOF waits for real cleanup before closing the upstream', async t => {
  const { peer, bridge, events, input } = await harness(t, { fixtureOptions: { cleanupDelay: 40 } });
  await peer.callTool({ name: 'js', arguments: {} });
  input.end();
  await bridge.closed;
  assert.deepEqual(events.slice(-2).map(event => event.event), ['turnEnded', 'close']);
});

test('idle ends an unused connection after its last call and performs cleanup', async t => {
  const { peer, bridge, events } = await harness(t, { idleTimeoutMs: 60 });
  await peer.callTool({ name: 'js', arguments: {} });
  await Promise.race([bridge.closed, delay(500).then(() => assert.fail('idle did not close'))]);
  assert.deepEqual(events.slice(-2).map(event => event.event), ['turnEnded', 'close']);
});

test('real vendored shared client preserves progress, images, and original host guard against fixture MCP', async t => {
  const clientModulePath = fileURLToPath(new URL('../vendor/lcu-client/client.mjs', import.meta.url));
  const runtimeCommand = [process.execPath, fileURLToPath(new URL('./fixtures/upstream-mcp.mjs', import.meta.url))];
  const { peer } = await harness(t, { createClient: null, clientModulePath, runtimeCommand,
    elicitation: async () => { assert.fail('Terminal approval must be refused before the person is asked'); } });
  // Explicitly use the actual vendored client rather than the injectable fixture.
  assert.equal(peer.getInstructions(), 'fixture original initialization instructions');
  const progress = [];
  assert.deepEqual(await peer.callTool({ name: 'js', arguments: { code: 'progress' } }, undefined,
    { onprogress: update => progress.push(update) }), imageResult);
  assert.equal(progress[0].message, 'real upstream progress');
  const refused = await peer.callTool({ name: 'js', arguments: { code: 'approval', app: 'com.apple.Terminal' } });
  assert.equal(JSON.parse(refused.content[0].text).action, 'decline');
});

test('SIGTERM drains cleanup before closing upstream', async t => {
  const { peer, bridge, events } = await harness(t, { fixtureOptions: { cleanupDelay: 20 } });
  await peer.callTool({ name: 'js', arguments: {} });
  process.emit('SIGTERM');
  await bridge.closed;
  assert.deepEqual(events.slice(-2).map(event => event.event), ['turnEnded', 'close']);
});

test('inherited test-only host-guard bypass cannot approve an agent host', async t => {
  const previous = process.env.LCU_ALLOW_AGENT_HOST_APPROVAL;
  process.env.LCU_ALLOW_AGENT_HOST_APPROVAL = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.LCU_ALLOW_AGENT_HOST_APPROVAL;
    else process.env.LCU_ALLOW_AGENT_HOST_APPROVAL = previous;
  });
  let asked = 0;
  const { peer, events } = await harness(t, { fixtureOptions: { app: 'com.apple.Terminal' },
    elicitation: async () => { asked++; return { action: 'accept', content: {} }; } });
  await peer.callTool({ name: 'js', arguments: { code: 'approval' } });
  assert.equal(asked, 0);
  assert.deepEqual(events.find(event => event.event === 'approval').response, { action: 'decline' });
});

test('failed cancellation cleanup closes the connection instead of renewing an unsafe context', async t => {
  const { peer, bridge, events, errors } = await harness(t, { fixtureOptions: { cleanupFailure: true } });
  const initial = bridge.connectionIdentity;
  const controller = new AbortController();
  const pending = peer.callTool({ name: 'js', arguments: { code: 'hang' } }, undefined, { signal: controller.signal });
  await until(() => events.some(event => event.event === 'call'));
  controller.abort(new Error('user interrupted'));
  await assert.rejects(pending, /user interrupted/);
  await bridge.closed;
  assert.equal(bridge.connectionIdentity.turnId, initial.turnId);
  assert.equal(events.at(-1).event, 'close');
  assert.match(errors(), /fixture cleanup failed/);
});


test('model timeout arguments cannot exceed the configured active-time budget', async t => {
  const { peer, events } = await harness(t, { requestTimeoutMs: 30 });
  await assert.rejects(peer.callTool({ name: 'js', arguments: { code: 'hang', timeout_ms: 2147483647 } }), /timed out/);
  await until(() => events.some(event => event.event === 'turnEnded'));
});

test('native MCP surface exposes the original ten operation names and preserves image blocks', async t => {
  const { NATIVE_TOOLS } = await import('../src/native-tools.mjs');
  let called;
  const createClient = () => ({
    async connect() {}, instructions,
    publicTools: () => tools,
    async call(name,args,meta) { called={name,args,meta};return imageResult; },
    async turnEnded() {}, async close() {},
  });
  const {peer} = await harness(t,{toolSurface:'native',createClient});
  assert.deepEqual((await peer.listTools()).tools,NATIVE_TOOLS);
  assert.match(peer.getInstructions(),/ten native/);
  assert.deepEqual(await peer.callTool({name:'get_app_state',arguments:{app:'Finder'}}),imageResult);
  assert.equal(called.name,'js');assert.match(called.args.code,/cua.getApp/);assert.match(called.args.code,/getScreenshot/);
  await assert.rejects(peer.callTool({name:'js',arguments:{code:'not exposed'}}),/Unknown Computer Use tool/);
});
