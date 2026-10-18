import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findPluginOwner, pluginInstallation, uninstallCheck } from '../src/cleanup.mjs';
import { libraryMcpDefinition, removeLibraryMcp } from '../src/library.mjs';
import { PLUGIN_NAME, PROJECT_ROOT } from '../src/config.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magpie-uninstall-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'magpie');
  await fs.mkdir(directory);
  const definition = libraryMcpDefinition(directory);
  const owner = { spec: PROJECT_ROOT, root: PROJECT_ROOT };
  const writeRegistry = plugins => fs.writeFile(path.join(directory, 'plugins.json'), JSON.stringify({ plugins }));
  const read = async () => JSON.parse(await fs.readFile(path.join(directory, 'library.json'), 'utf8'));
  const writeLibrary = mcp => fs.writeFile(path.join(directory, 'library.json'), JSON.stringify({ mcp, skills: [{ name: 'keep' }] }));
  await writeRegistry([{ spec: PROJECT_ROOT }]);
  await writeLibrary([definition, { name: 'other', command: 'other', agents: ['claude'] }]);
  const calls = [];
  const runner = async (executable, args, options) => {
    calls.push({ executable, args, options });
    const library = await read();
    library.mcp = library.mcp.filter(entry => entry.name !== args[3]);
    await fs.writeFile(path.join(directory, 'library.json'), JSON.stringify(library));
  };
  let time = 0;
  const check = (overrides = {}) => uninstallCheck({ directory, definition, owner, magpie: '/test/magpie', graceMs: 10, now: () => time,
    remove: (dir, def, options) => removeLibraryMcp(dir, def, { ...options, runner }), ...overrides });
  return { root, directory, owner, definition, calls, read, writeRegistry, writeLibrary, check, advance: value => { time += value; } };
}

test('normal reloads, disabling, and npm version changes preserve the MCP', async t => {
  const f = await fixture(t);
  const check = f.check();
  assert.equal(await check(), 'installed');
  f.advance(100);
  await f.writeRegistry([{ spec: PROJECT_ROOT, off: true }]);
  assert.equal(await check(), 'installed');
  // npm 版本更新必须指向同一个安装目标，而不是同名的另一个本地副本。
  await fs.mkdir(path.join(f.directory, 'plugins/node_modules'), { recursive: true });
  await fs.symlink(PROJECT_ROOT, path.join(f.directory, 'plugins/node_modules', PLUGIN_NAME));
  await f.writeRegistry([{ spec: `${PLUGIN_NAME}@0.5.1` }]);
  assert.equal(await check(), 'installed');
  assert.equal(f.calls.length, 0);
  assert.equal((await f.read()).mcp.length, 2);
});

test('missing, malformed, and partially written registry never count as an uninstall', async t => {
  const f = await fixture(t);
  const check = f.check();
  const file = path.join(f.directory, 'plugins.json');
  for (const contents of ['', '{', '{}', '{"plugins":[{}]}']) {
    await fs.writeFile(file, contents);
    f.advance(100);
    assert.equal(await check(), 'unknown');
  }
  await fs.unlink(file);
  assert.equal(await check(), 'unknown');
  assert.equal(f.calls.length, 0);
});

test('a stable uninstall removes only the owned MCP through magpie and keeps other resources', async t => {
  const f = await fixture(t);
  const check = f.check();
  await f.writeRegistry([{ spec: 'unrelated-plugin' }]);
  assert.equal(await check(), 'waiting');
  f.advance(10);
  assert.equal(await check(), 'done');
  assert.deepEqual(f.calls[0].args, ['library', 'mcp', 'rm', PLUGIN_NAME]);
  assert.equal(f.calls[0].options.env.XDG_CONFIG_HOME, path.dirname(f.directory));
  assert.deepEqual(await f.read(), { mcp: [{ name: 'other', command: 'other', agents: ['claude'] }], skills: [{ name: 'keep' }] });
});

test('reinstalling during the grace period cancels cleanup and starts a fresh grace later', async t => {
  const f = await fixture(t);
  const check = f.check();
  await f.writeRegistry([]);
  assert.equal(await check(), 'waiting');
  f.advance(20);
  await f.writeRegistry([{ spec: PROJECT_ROOT }]);
  assert.equal(await check(), 'installed');
  await f.writeRegistry([]);
  assert.equal(await check(), 'waiting');
  assert.equal(f.calls.length, 0);
  f.advance(10);
  assert.equal(await check(), 'done');
});

test('a same-name custom replacement and a last-minute reinstall are never removed', async t => {
  const f = await fixture(t);
  await f.writeRegistry([]);
  const custom = { ...f.definition, command: '/custom/server' };
  await f.writeLibrary([custom]);
  assert.equal(await f.check()(), 'done');
  assert.equal(await removeLibraryMcp(f.directory, f.definition, { magpie: '/test/magpie', runner: () => assert.fail('must not run') }), false);
  await f.writeLibrary([f.definition]);
  assert.equal(await removeLibraryMcp(f.directory, f.definition, { magpie: '/test/magpie', shouldRemove: async () => false, runner: () => assert.fail('must not run') }), false);
  assert.deepEqual((await f.read()).mcp, [f.definition]);
});

test('a failed removal remains retryable without discarding the entry', async t => {
  const f = await fixture(t);
  let failed = false;
  const check = f.check({ remove: async (dir, def, options) => {
    if (!failed) { failed = true; throw new Error('temporary sync failure'); }
    return removeLibraryMcp(dir, def, { ...options, runner: async () => f.writeLibrary([]) });
  } });
  await f.writeRegistry([]);
  assert.equal(await check(), 'waiting');
  f.advance(10);
  await assert.rejects(check(), /temporary sync failure/);
  assert.equal((await f.read()).mcp[0].name, PLUGIN_NAME);
  assert.equal(await check(), 'done');
});

test('ownership recognizes canonical local paths and installed Git mappings, not similar package names', async t => {
  const f = await fixture(t);
  await f.writeRegistry([{ spec: `${PLUGIN_NAME}-unrelated` }]);
  assert.equal(await findPluginOwner(f.directory), null);
  await f.writeRegistry([{ spec: pathToFileURL(PROJECT_ROOT).href }]);
  assert.equal((await findPluginOwner(f.directory)).root, PROJECT_ROOT);
  const git = 'github:wbb6517/magpie-computer-use#v0.5.0';
  await fs.mkdir(path.join(f.directory, 'plugins/node_modules'), { recursive: true });
  await fs.symlink(PROJECT_ROOT, path.join(f.directory, 'plugins/node_modules', PLUGIN_NAME));
  await fs.writeFile(path.join(f.directory, 'plugins/package.json'), JSON.stringify({ dependencies: { [PLUGIN_NAME]: git } }));
  await f.writeRegistry([{ spec: git }]);
  const owner = await findPluginOwner(f.directory);
  assert.equal(owner.spec, git);
  // bun remove 会删依赖映射；已经捕获的 owner 仍按确切 spec 判断。
  await fs.unlink(path.join(f.directory, 'plugins/package.json'));
  assert.equal(await pluginInstallation(f.directory, owner), 'installed');
  await f.writeRegistry([]);
  assert.equal(await pluginInstallation(f.directory, owner), 'removed');
});

test('a separately installed npm copy does not keep an uninstalled local owner alive', async t => {
  const f = await fixture(t);
  await f.writeRegistry([{ spec: `${PLUGIN_NAME}@0.5.0` }]);
  await fs.mkdir(path.join(f.directory, 'plugins/node_modules', PLUGIN_NAME), { recursive: true });
  assert.equal(await pluginInstallation(f.directory, f.owner), 'removed');
});

test('MCP and project cleanup ledgers keep a nominally successful deletion retryable', async t => {
  const f = await fixture(t);
  const library = await f.read();
  library.applied = { claude: { mcp: [PLUGIN_NAME] } };
  library.projects = [{ wrote: { '.mcp.json': [PLUGIN_NAME] } }];
  await fs.writeFile(path.join(f.directory, 'library.json'), JSON.stringify(library));
  let syncs = 0;
  const check = f.check({ sync: async (_directory, { shouldSync }) => {
    assert.equal(await shouldSync(), true);
    const current = await f.read();
    if (++syncs === 1) current.applied.claude.mcp = [];
    else current.projects[0].wrote['.mcp.json'] = [];
    await fs.writeFile(path.join(f.directory, 'library.json'), JSON.stringify(current));
  } });
  await f.writeRegistry([]);
  assert.equal(await check(), 'waiting');
  f.advance(10);
  assert.equal(await check(), 'waiting');
  assert.equal((await f.read()).mcp.some(e => e.name === PLUGIN_NAME), false);
  assert.equal(await check(), 'done');
  assert.equal(syncs, 2);
});

test('reinstalling while rm executes restores the missing registration', async t => {
  const f = await fixture(t);
  let restored = 0;
  const check = f.check({ remove: async () => {
    await f.writeRegistry([{ spec: PROJECT_ROOT }]);
    await f.writeLibrary([]);
  }, restore: async () => { restored++; await f.writeLibrary([f.definition]); } });
  await f.writeRegistry([]);
  assert.equal(await check(), 'waiting');
  f.advance(10);
  assert.equal(await check(), 'installed');
  assert.equal(restored, 1);
  assert.equal(await check(), 'installed');
  assert.deepEqual((await f.read()).mcp, [f.definition]);
});
