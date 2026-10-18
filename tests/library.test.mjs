import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import plugin, { _internal } from '../index.mjs';
import { ensureLibraryMcp, libraryMcpDefinition, snapshotPath } from '../src/library.mjs';
import { PLUGIN_NAME } from '../src/config.mjs';

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

async function assertNoPrivateConfig(directory) {
  await assert.rejects(fs.stat(path.join(directory, 'plugins')), { code: 'ENOENT' });
}

test('magpie plugin loading registers an unassigned MCP without creating a private configuration', async t => {
  const f = await fixture(t);
  const entry = _internal.createPlugin(f.dependencies);
  assert.equal(plugin.id, PLUGIN_NAME);
  assert.deepEqual(await entry.server({ directory: f.directory }, {}), {});
  const library = await f.read();
  assert.deepEqual(library.mcp, [libraryMcpDefinition(f.directory, f.launcher)]);
  assert.equal(library.mcp[0].args.length, 2);
  assert.equal(library.mcp[0].args[1], 'mcp');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].command, '/test/magpie');
  assert.deepEqual(f.calls[0].args.slice(0, 4), ['library', 'mcp', 'add', PLUGIN_NAME]);
  assert.equal(f.calls[0].args.at(-1), 'agents=');
  assert.equal(f.calls[0].options.env.XDG_CONFIG_HOME, path.dirname(f.directory));
  await assertNoPrivateConfig(f.directory);
});

test('obsolete plugin options have no effect on the registration definition', async t => {
  const f = await fixture(t);
  await ensureLibraryMcp({ directory: f.directory }, { appPath: '../wrong', chrome: 'invalid', requestTimeoutMs: 2, idleTimeoutMs: -1 }, f.dependencies);
  assert.deepEqual((await f.read()).mcp[0], libraryMcpDefinition(f.directory, f.launcher));
  await assertNoPrivateConfig(f.directory);
});

test('reloading an existing definition preserves every field and executes no command', async t => {
  const f = await fixture(t);
  const existing = { ...libraryMcpDefinition(f.directory, f.launcher), agents: ['claude', 'codex'], disabledTools: ['click'], headers: { 'user-field': 'keep' } };
  await f.write({ mcp: [existing], skills: [{ name: 'mine' }], applied: { claude: { mcp: [PLUGIN_NAME] } } });
  const original = await fs.readFile(path.join(f.directory, 'library.json'), 'utf8');
  const result = await ensureLibraryMcp({ directory: f.directory }, { chrome: true }, f.dependencies);
  assert.equal(result.created, false);
  assert.equal(f.calls.length, 0);
  assert.equal(await fs.readFile(path.join(f.directory, 'library.json'), 'utf8'), original);
  await assertNoPrivateConfig(f.directory);
});

test('the exact previous snapshot definition remains compatible without reading its contents or changing the entry', async t => {
  const f = await fixture(t);
  const definition = libraryMcpDefinition(f.directory, f.launcher);
  const legacy = { ...definition, args: [...definition.args, '--config', snapshotPath(f.directory)], agents: ['claude'], disabledTools: ['scroll'], env: { CUSTOM: 'keep' } };
  await f.write({ mcp: [legacy] });
  // No snapshot exists: compatibility cannot rely on reading or creating it.
  const original = await fs.readFile(path.join(f.directory, 'library.json'), 'utf8');
  const result = await ensureLibraryMcp({ directory: f.directory }, null, f.dependencies);
  assert.equal(result.created, false);
  assert.equal(f.calls.length, 0);
  assert.equal(await fs.readFile(path.join(f.directory, 'library.json'), 'utf8'), original);
  await assertNoPrivateConfig(f.directory);
});

test('an obsolete private snapshot is left untouched rather than removed while a prior host may still use it', async t => {
  const f = await fixture(t);
  const definition = libraryMcpDefinition(f.directory, f.launcher);
  const snapshot = snapshotPath(f.directory);
  await fs.mkdir(path.dirname(snapshot), { recursive: true });
  await fs.writeFile(snapshot, '{ deliberately malformed legacy options');
  await f.write({ mcp: [{ ...definition, args: [...definition.args, '--config', snapshot], agents: ['claude'] }] });
  await ensureLibraryMcp({ directory: f.directory }, {}, f.dependencies);
  assert.equal(await fs.readFile(snapshot, 'utf8'), '{ deliberately malformed legacy options');
  assert.equal(f.calls.length, 0);
});

test('a foreign same-name resource is never overwritten', async t => {
  const f = await fixture(t);
  const library = { mcp: [{ name: PLUGIN_NAME, transport: 'stdio', command: '/some/other/server', args: [], agents: ['claude'] }] };
  await f.write(library);
  await assert.rejects(ensureLibraryMcp({ directory: f.directory }, {}, f.dependencies), /同名的其他或自定义 MCP/);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.read(), library);
  await assertNoPrivateConfig(f.directory);
});

test('custom arguments, changed launchers, and config paths outside our legacy location remain conflicts', async t => {
  const f = await fixture(t);
  const base = libraryMcpDefinition(f.directory, f.launcher);
  const variants = [
    { ...base, command: '/another/bun' },
    { ...base, args: [...base.args, '--surface', 'javascript'] },
    { ...base, args: [...base.args, '--config', '/private/user-options.json'] },
    { ...base, args: [...base.args, '--config', snapshotPath(f.directory), '--app', '/custom/app'] },
    { ...base, transport: 'http', url: 'http://localhost:9999/mcp' },
  ];
  for (const entry of variants) {
    await f.write({ mcp: [entry] });
    await assert.rejects(ensureLibraryMcp({ directory: f.directory }, {}, f.dependencies), /同名的其他或自定义 MCP/);
    assert.deepEqual((await f.read()).mcp[0], entry);
  }
  assert.equal(f.calls.length, 0);
  await assertNoPrivateConfig(f.directory);
});

test('invalid host paths create no files and execute no command', async t => {
  const f = await fixture(t);
  await assert.rejects(ensureLibraryMcp({ directory: 'relative' }, {}, f.dependencies), /绝对路径/);
  await assert.rejects(ensureLibraryMcp({}, {}, f.dependencies), /绝对路径/);
  await assert.rejects(ensureLibraryMcp({ directory: f.directory }, {}, { ...f.dependencies, launcher: 'bun' }), /绝对路径/);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test('malformed library data remains an error rather than becoming an empty library', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.directory, 'library.json'), '{broken');
  await assert.rejects(ensureLibraryMcp({ directory: f.directory }, {}, f.dependencies), /无法读取 magpie 资源库/);
  assert.equal(f.calls.length, 0);
  await assertNoPrivateConfig(f.directory);
});
