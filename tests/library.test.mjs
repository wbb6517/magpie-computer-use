import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import plugin, { _internal } from '../index.mjs';
import { ensureLibraryMcp, libraryMcpDefinition, snapshotPath } from '../src/library.mjs';
import { normalizeOptions, PLUGIN_NAME } from '../src/config.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magpie-library-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'magpie');
  await fs.mkdir(directory);
  const file = path.join(directory, 'library.json');
  const calls = [];
  const write = value => fs.writeFile(file, JSON.stringify(value));
  const read = async () => JSON.parse(await fs.readFile(file, 'utf8'));
  const launcher = '/test/magpie-bun';
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    let library;
    try { library = await read(); } catch (error) { if (error.code !== 'ENOENT') throw error; library = { mcp: [] }; }
    const commandIndex = 4;
    const parameters = args.slice(commandIndex + 1).filter(argument => !argument.startsWith('agents='));
    library.mcp ??= [];
    library.mcp.push({ name: args[3], transport: 'stdio', command: args[commandIndex], args: parameters, agents: [] });
    await write(library);
    return { code: 0, stdout: '', stderr: '' };
  };
  return { directory, calls, launcher, runner, write, read, dependencies: { runner, launcher, magpie: '/test/magpie' } };
}

test('magpie plugin loading creates its private snapshot and unassigned resource MCP', async t => {
  const f = await fixture(t);
  const entry = _internal.createPlugin(f.dependencies);
  assert.equal(plugin.id, PLUGIN_NAME);
  assert.deepEqual(await entry.server({ directory: f.directory }, {}), {});
  const library = await f.read();
  assert.equal(library.mcp.length, 1);
  assert.deepEqual(library.mcp[0], libraryMcpDefinition(f.directory, f.launcher));
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].command, '/test/magpie');
  assert.deepEqual(f.calls[0].args.slice(0, 4), ['library', 'mcp', 'add', PLUGIN_NAME]);
  assert.equal(f.calls[0].args.at(-1), 'agents=');
  assert.equal(f.calls[0].options.env.XDG_CONFIG_HOME, path.dirname(f.directory));
  assert.equal(f.calls[0].options.inherit, undefined);
  const snapshot = snapshotPath(f.directory);
  assert.deepEqual(JSON.parse(await fs.readFile(snapshot, 'utf8')), normalizeOptions());
  assert.equal((await fs.stat(path.dirname(snapshot))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(snapshot)).mode & 0o777, 0o600);
});

test('loading new options updates the snapshot without rewriting Agent choices or disabled tools', async t => {
  const f = await fixture(t);
  const existing = { ...libraryMcpDefinition(f.directory, f.launcher), agents: ['claude', 'codex'], disabledTools: ['click'], headers: { 'user-field': 'keep' } };
  const library = { mcp: [existing], skills: [{ name: 'mine' }], applied: { claude: { mcp: [PLUGIN_NAME] } } };
  await f.write(library);
  const original = await fs.readFile(path.join(f.directory, 'library.json'), 'utf8');
  const result = await ensureLibraryMcp({ directory: f.directory }, { chrome: true, requestTimeoutMs: 180000 }, f.dependencies);
  assert.equal(result.created, false);
  assert.equal(f.calls.length, 0);
  assert.equal(await fs.readFile(path.join(f.directory, 'library.json'), 'utf8'), original);
  const saved = JSON.parse(await fs.readFile(snapshotPath(f.directory), 'utf8'));
  assert.equal(saved.chrome, true);
  assert.equal(saved.requestTimeoutMs, 180000);
  await ensureLibraryMcp({ directory: f.directory }, { chrome: false }, f.dependencies);
  assert.equal(f.calls.length, 0);
  assert.equal(JSON.parse(await fs.readFile(snapshotPath(f.directory), 'utf8')).chrome, false);
});

test('a foreign same-name resource is never overwritten or given a new snapshot', async t => {
  const f = await fixture(t);
  const library = { mcp: [{ name: PLUGIN_NAME, transport: 'stdio', command: '/some/other/server', args: [], agents: ['claude'] }] };
  await f.write(library);
  await assert.rejects(ensureLibraryMcp({ directory: f.directory }, {}, f.dependencies), /同名的其他 MCP/);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.read(), library);
  await assert.rejects(fs.stat(snapshotPath(f.directory)), { code: 'ENOENT' });
});

test('a previous direct runtime entry requires editing in magpie instead of remove/add migration', async t => {
  const f = await fixture(t);
  const definition = libraryMcpDefinition(f.directory, f.launcher);
  const legacy = { ...definition, command: '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node', args: definition.args.slice(0, 2).concat(['--app', '/Applications/ChatGPT.app']), agents: ['claude'], disabledTools: ['scroll'] };
  await f.write({ mcp: [legacy] });
  await assert.rejects(ensureLibraryMcp({ directory: f.directory }, {}, f.dependencies), /旧版 MCP 配置.*资源库编辑/);
  assert.equal(f.calls.length, 0);
  assert.deepEqual((await f.read()).mcp[0], legacy);
});

test('invalid plugin options or host directory create no files and execute no command', async t => {
  const f = await fixture(t);
  await assert.rejects(ensureLibraryMcp({ directory: f.directory }, { requestTimeoutMs: 2 }, f.dependencies), /requestTimeoutMs/);
  await assert.rejects(ensureLibraryMcp({ directory: 'relative' }, {}, f.dependencies), /绝对路径/);
  await assert.rejects(ensureLibraryMcp({}, {}, f.dependencies), /绝对路径/);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test('malformed library data is an error rather than an empty library', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.directory, 'library.json'), '{broken');
  await assert.rejects(ensureLibraryMcp({ directory: f.directory }, {}, f.dependencies), /无法读取 magpie 资源库/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(fs.stat(snapshotPath(f.directory)), { code: 'ENOENT' });
});

test('a private configuration directory cannot be a symlink out of the plugin area', async t => {
  const f = await fixture(t);
  const outside = path.join(f.directory, 'elsewhere');
  await fs.mkdir(outside);
  await fs.mkdir(path.join(f.directory, 'plugins'));
  await fs.symlink(outside, path.dirname(snapshotPath(f.directory)));
  await assert.rejects(ensureLibraryMcp({ directory: f.directory }, {}, f.dependencies), /符号链接/);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await fs.readdir(outside), []);
});
