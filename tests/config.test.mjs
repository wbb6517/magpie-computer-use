import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOptions, runtimePaths, loadOptions, DEFAULTS } from '../src/config.mjs';
import { verifyOfficialApp } from '../src/bootstrap.mjs';
import { assertRuntimeEnvironment, parseArgs } from '../src/cli.mjs';

test('automatic runtime options ignore obsolete overrides and reject nonlocal diagnostic paths', () => {
  const options = normalizeOptions({ appPath: '/test/Codex.app', chrome: true, requestTimeoutMs: 2, idleTimeoutMs: -1 });
  assert.deepEqual({ requestTimeoutMs: options.requestTimeoutMs, idleTimeoutMs: options.idleTimeoutMs }, DEFAULTS);
  assert.equal(options.chrome, false);
  for (const appPath of ['./Codex.app', 42, '/tmp/a\ncommand']) assert.throws(() => normalizeOptions({ appPath }), /绝对路径/);
});

test('a missing legacy config file never disables automatic discovery or changes runtime argv', () => {
  const options = loadOptions({ configFile: '/does-not-exist/options.json', env: { CODEX_HOME: '/nonexistent/codex' }, discover: () => '/test/Renamed.app' });
  const paths = runtimePaths(options);
  assert.deepEqual(paths.runtimeCommand.slice(2), ['--app', '/test/Renamed.app']);
  assert.doesNotMatch(paths.runtimeCommand.join(' '), /options\.json|\.runtime\/lcu/);
});

test('unrecognized app signer is rejected before execution or deep validation', async () => {
  let calls = 0;
  await assert.rejects(verifyOfficialApp('/wrong.app', { runner: async () => { calls++; return { stdout: '', stderr: 'TeamIdentifier=OTHER\n' }; } }), /官方 Codex/);
  assert.equal(calls, 1);
  const args = [];
  await verifyOfficialApp('/signed.app', { runner: async (_cmd, argv) => { args.push(argv); return { stdout: '', stderr: 'TeamIdentifier=2DC432GLL2\n' }; } });
  assert.deepEqual(args[1], ['--verify', '--deep', '--strict', '/signed.app']);
});

test('unsafe upstream override is refused and CLI accepts old config syntax only for compatibility', () => {
  assert.throws(() => assertRuntimeEnvironment({ LCU_ALLOW_AGENT_HOST_APPROVAL: '1' }), /不允许控制/);
  assert.throws(() => assertRuntimeEnvironment({ LCU_NODE_REPL_SANDBOX: 'off' }), /沙箱/);
  assert.throws(() => parseArgs(['mcp', '--config']), /缺少值/);
  assert.throws(() => parseArgs(['prepare', '--unattended']), /未知参数/);
  assert.deepEqual(parseArgs(['mcp', '--config', '/tmp/options.json']), { command: 'mcp', config: '/tmp/options.json' });
});
