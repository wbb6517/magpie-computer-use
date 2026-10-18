import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverCodexApp } from '../src/codex.mjs';
import { readCodexRuntimeSettings } from '../src/codex-settings.mjs';
import { runtimeEnvironment } from '../src/gateway/entry.mjs';

const result = stdout => ({ status: 0, stdout });
const runtime = { runtimePath: '/official/Resources/cua_node', resources: '/official/Resources',
  nodePath: '/official/node', nodeReplPath: '/official/node_repl', codexCli: '/official/codex',
  helperPath: '/official/Helper.app', servicePath: '/official/service.js', macClientPath: '/official/client.js', appVersion: 'test' };

test('discovery follows the native configured installation even when another default app exists', () => {
  const wanted = '/Relocated/My Codex.app';
  const app = discoverCodexApp({ env: { CODEX_CLI_PATH: wanted + '/Contents/Resources/codex' }, probe: path => [wanted, '/Applications/ChatGPT.app'].includes(path), runner: () => { throw Error('must not enumerate'); } });
  assert.equal(app, wanted);
});

test('running installations take priority over stale default copies and ambiguity is explicit', () => {
  const a = '/Custom/First.app', b = '/Custom/Second.app';
  const probe = path => [a, b, '/Applications/ChatGPT.app'].includes(path);
  const one = () => result(a + '/Contents/MacOS/First');
  assert.equal(discoverCodexApp({ env: {}, executable: '/usr/bin/node', probe, runner: one }), a);
  assert.throws(() => discoverCodexApp({ env: {}, executable: '/usr/bin/node', probe, runner: () => result(a + '/Contents/MacOS/First\n' + b + '/Contents/MacOS/Second') }), /多份 Codex/);
});

test('discovery works without process access and supports indexed renamed apps', () => {
  const probe = app => app === '/Other/Named.app';
  const runner = command => command === '/usr/bin/mdfind' ? result('/Other/Named.app\n') : { status: null, stdout: '' };
  assert.equal(discoverCodexApp({ env: {}, executable: '/usr/bin/node', probe, runner }), '/Other/Named.app');
  assert.throws(() => discoverCodexApp({ env: {}, executable: '/usr/bin/node', probe: () => false, runner: () => result('') }), /未找到/);
});

test('Codex runtime settings use real TOML parsing and exclude identity, credentials and session approvals', () => {
  const text = `[mcp_servers.node_repl.env]\nBROWSER_USE_AVAILABLE_BACKENDS = "chrome,iab,mcpapps"\nBROWSER_USE_TINYSKY_ENABLED = '1'\nNODE_REPL_TRUSTED_SERVICES = '{"browser":"/native/browser-service.mjs","sky":"/other/sky.mjs"}'\nCODEX_CLI_PATH = '/installed/Codex.app/Contents/Resources/codex'\nBROWSER_USE_ACCESS_EXECUTOR_ID = 'session-private'\nBROWSER_USE_VERIFYING_IDENTITY = 'private'\nNODE_REPL_HOST_SERVICES_PIPE_PATH = '/another/chat.sock'\nAPI_KEY = 'do-not-copy'\n`;
  const native = readCodexRuntimeSettings({ env: { CODEX_HOME: '/test/codex' }, read: () => text });
  assert.deepEqual(native.environment, { BROWSER_USE_AVAILABLE_BACKENDS: 'chrome,iab,mcpapps', BROWSER_USE_TINYSKY_ENABLED: '1' });
  assert.equal(native.browserService, '/native/browser-service.mjs');
  assert.equal(native.codexCli, '/installed/Codex.app/Contents/Resources/codex');
  assert.doesNotMatch(JSON.stringify(native), /session-private|do-not-copy|another\/chat/);
});

test('missing native configuration uses defaults; malformed TOML does not leak parser excerpts', () => {
  const missing = () => { throw Object.assign(Error('missing'), { code: 'ENOENT' }); };
  assert.deepEqual(readCodexRuntimeSettings({ env: {}, home: '/account', read: missing }), { codexHome: '/account/.codex', environment: {} });
  const secret = 'sensitive-do-not-print';
  assert.throws(() => readCodexRuntimeSettings({ env: {}, home: '/account', read: () => `x = "${secret}` }), error => !error.message.includes(secret) && /config.toml/.test(error.message));
});

test('gateway preserves real inherited native connections without forcing Chrome-only defaults', () => {
  const base = { CODEX_HOME: '/nonexistent/test-codex-home', NODE_REPL_HOST_SERVICES_PIPE_PATH: '/current/chat.sock',
    SKY_CUA_SERVICE_NATIVE_PIPE_PATH: '/current/native.sock', BROWSER_USE_AVAILABLE_BACKENDS: 'chrome,iab,mcpapps' };
  const env = runtimeEnvironment(runtime, { chrome: true, env: base });
  assert.equal(env.BROWSER_USE_AVAILABLE_BACKENDS, 'chrome,iab,mcpapps');
  assert.equal(env.NODE_REPL_HOST_SERVICES_PIPE_PATH, base.NODE_REPL_HOST_SERVICES_PIPE_PATH);
  assert.equal(env.SKY_CUA_SERVICE_NATIVE_PIPE_PATH, base.SKY_CUA_SERVICE_NATIVE_PIPE_PATH);
  assert.equal(env.CUA_REPL_ENABLED_SURFACES, 'browser,computer');
  const fresh = runtimeEnvironment(runtime, { chrome: true, env: { CODEX_HOME: base.CODEX_HOME } });
  assert.equal(fresh.BROWSER_USE_AVAILABLE_BACKENDS, undefined);
  assert.equal(fresh.BROWSER_USE_TINYSKY_ENABLED, undefined);
  assert.equal(fresh.BROWSER_USE_CODEX_APP_BUILD_FLAVOR, undefined);
});

test('native config connection timeout is not overwritten by plugin defaults', async t => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'magpie-native-settings-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'config.toml'), '[mcp_servers.node_repl.env]\nNODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS = "7000"\n');
  assert.equal(runtimeEnvironment(runtime, { env: { CODEX_HOME: directory } }).NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS, '7000');
});
