import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOptions, runtimePaths, DEFAULTS } from '../src/config.mjs';
import { verifyOfficialApp } from '../src/bootstrap.mjs';
import { assertRuntimeEnvironment, parseArgs } from '../src/cli.mjs';

test('only local absolute original app paths and bounded timeouts are accepted', () => {
  assert.deepEqual(normalizeOptions(), DEFAULTS);
  assert.throws(() => normalizeOptions({ appPath: './ChatGPT.app' }), /绝对路径/);
  assert.throws(() => normalizeOptions({ appPath: 42 }), /字符串绝对路径/);
  assert.throws(() => normalizeOptions({ appPath: '/tmp/a\ncommand' }), /字符串绝对路径/);
  assert.throws(() => normalizeOptions({ chrome: 'true' }), /布尔值/);
  assert.throws(() => normalizeOptions({ requestTimeoutMs: 29_999 }), /requestTimeoutMs/);
  assert.throws(() => normalizeOptions({ idleTimeoutMs: 1_800_001 }), /idleTimeoutMs/);
  assert.equal(normalizeOptions({ chrome: true }).chrome, true);
});

test('old external LCU settings cannot change the embedded gateway command', () => {
  const options = normalizeOptions({ lcuPath: '/tmp/fake-lcu', chrome: true });
  assert.equal('lcuPath' in options, false);
  const paths = runtimePaths(options);
  assert.match(paths.runtimeCommand[1], /src\/gateway\/entry\.mjs$/);
  assert.deepEqual(paths.runtimeCommand.slice(2), ['--app', '/Applications/ChatGPT.app', '--chrome']);
  assert.doesNotMatch(paths.runtimeCommand.join(' '), /\.runtime\/lcu|\/bin\/lcu|fake-lcu/);
});

test('unrecognized app signer is rejected before execution or deep validation', async () => {
  let calls = 0;
  await assert.rejects(verifyOfficialApp('/wrong.app', { runner: async () => { calls++; return { stdout: '', stderr: 'TeamIdentifier=OTHER\n' }; } }), /官方 ChatGPT/);
  assert.equal(calls, 1);
  const args = [];
  await verifyOfficialApp('/signed.app', { runner: async (_cmd, argv) => { args.push(argv); return { stdout: '', stderr: 'TeamIdentifier=2DC432GLL2\n' }; } });
  assert.deepEqual(args[1], ['--verify', '--deep', '--strict', '/signed.app']);
});

test('unsafe upstream override is refused and CLI rejects ambiguous input', () => {
  assert.throws(() => assertRuntimeEnvironment({ LCU_ALLOW_AGENT_HOST_APPROVAL: '1' }), /不允许控制/);
  assert.throws(() => assertRuntimeEnvironment({ LCU_NODE_REPL_SANDBOX: 'off' }), /沙箱/);
  assert.throws(() => parseArgs(['mcp', '--config']), /缺少值/);
  assert.throws(() => parseArgs(['prepare', '--unattended']), /未知参数/);
  assert.deepEqual(parseArgs(['mcp', '--config', '/tmp/options.json']), { command: 'mcp', config: '/tmp/options.json' });
});

