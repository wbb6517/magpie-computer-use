/**
 * magpie 尚无卸载回调，且卸载 npm 包时跳过 scripts。独立监视进程只负责资源库清理，
 * 不启动 Computer Use、不安装系统服务，也不把宿主退出当成卸载。
 * 本模块的静态依赖在启动时已载入；包文件被卸载后仍可完成清理。
 */
import fs from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT, PLUGIN_NAME } from './config.mjs';
import { acceptedDefinition, ensureLibraryMcp, locateMagpie, pendingMcpRemoval, readLibrary, removeLibraryMcp, syncMcpRemoval } from './library.mjs';

const READY = 'magpie-computer-use cleanup v1\n';
const POLL_MS = 5000;
const GRACE_MS = 1200;

async function canonical(file) {
  try { return await fs.realpath(file); } catch { return path.resolve(file); }
}

async function registry(directory) {
  try {
    const value = JSON.parse(await fs.readFile(path.join(directory, 'plugins.json'), 'utf8'));
    if (!Array.isArray(value?.plugins) || value.plugins.some(entry => !entry || typeof entry.spec !== 'string' || !entry.spec)) return null;
    return value.plugins;
  } catch { return null; } // 缺失、半写入或读失败均为未知，不能据此删配置。
}

function npmSpec(spec) {
  return spec === PLUGIN_NAME || spec.startsWith(`${PLUGIN_NAME}@`) && spec.length > PLUGIN_NAME.length + 1;
}

async function targetsOwner(spec, directory, root) {
  if (npmSpec(spec)) return await canonical(path.join(directory, 'plugins/node_modules', PLUGIN_NAME)) === root;
  if (spec.startsWith('file://') || path.isAbsolute(spec)) {
    let target;
    try { target = spec.startsWith('file://') ? fileURLToPath(spec) : spec; } catch { return false; }
    target = await canonical(target);
    return target === root || target === path.join(root, 'index.mjs');
  }
  // Git spec 的包名由 magpie 安装时记录；不能仅凭仓库名中含 computer-use 就认领。
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'plugins/package.json'), 'utf8'));
    return manifest.dependencies?.[PLUGIN_NAME] === spec &&
      await canonical(path.join(directory, 'plugins/node_modules', PLUGIN_NAME)) === root;
  } catch { return false; }
}

export async function findPluginOwner(directory, root = PROJECT_ROOT) {
  const entries = await registry(directory);
  if (!entries) return null;
  root = await canonical(root);
  for (const entry of entries) {
    if (await targetsOwner(entry.spec, directory, root)) return { spec: entry.spec, root };
  }
  return null;
}

/** off:true 仍然是已安装；只有有效安装列表明确不含本插件才算 removed。 */
export async function pluginInstallation(directory, owner) {
  const entries = await registry(directory);
  if (!entries) return 'unknown';
  for (const entry of entries) {
    if (entry.spec === owner.spec || await targetsOwner(entry.spec, directory, owner.root)) return 'installed';
  }
  return 'removed';
}

export function cleanupSocket(directory, definition) {
  const key = createHash('sha256').update(`${directory}\0${definition.command}\0${definition.args[0]}`).digest('hex').slice(0, 20);
  const name = `magpie-cu-${key}.sock`;
  const candidate = path.join(os.tmpdir(), name);
  // macOS Unix socket 路径上限很小，配置目录不放进 socket 名。
  return Buffer.byteLength(candidate) < 100 ? candidate : `/tmp/magpie-cu-${process.getuid?.() ?? 'user'}-${key}.sock`;
}

async function isWatching(socket) {
  return await new Promise(resolve => {
    const client = net.createConnection(socket);
    let text = '';
    const finish = value => { clearTimeout(timer); client.destroy(); resolve(value); };
    const timer = setTimeout(() => finish(false), 400);
    client.on('data', chunk => { text += chunk; if (text.includes('\n')) finish(text === READY); });
    client.once('error', () => finish(false));
    client.once('end', () => finish(text === READY));
  });
}

async function listen(socket) {
  const server = net.createServer(client => client.end(READY, () => client.destroy()));
  const bind = () => new Promise((resolve, reject) => {
    const fail = error => { server.off('listening', done); reject(error); };
    const done = () => { server.off('error', fail); resolve(); };
    server.once('error', fail);
    server.once('listening', done);
    server.listen(socket);
  });
  try { await bind(); }
  catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    const stale = await fs.lstat(socket).catch(() => null);
    if (await isWatching(socket)) return null;
    const current = await fs.lstat(socket).catch(() => null);
    if (current && (stale?.ino !== current.ino || stale?.dev !== current.dev)) return null;
    if (current) await fs.unlink(socket);
    try { await bind(); } catch (retry) { if (retry.code === 'EADDRINUSE') return null; throw retry; }
  }
  await fs.chmod(socket, 0o600);
  return server;
}

/** 返回一个有状态检查器，使原子替换、更新、重新安装与清理重试均走同一判断。 */
export function uninstallCheck({ directory, definition, owner, magpie, graceMs = GRACE_MS,
  remove = removeLibraryMcp, sync = syncMcpRemoval,
  // 卸载已开始后再重装属于新安装；恢复默认未分发入口，不把旧选择强加给新安装。
  restore = () => ensureLibraryMcp({ directory }, undefined, { launcher: definition.command, magpie }), now = Date.now,
}) {
  let absentSince, removing = false;
  const ownEntry = library => library.mcp?.find(item => item?.name === PLUGIN_NAME);
  const foreign = entry => entry && !acceptedDefinition(entry, definition, directory);
  const canSync = async () => await pluginInstallation(directory, owner) === 'removed' && !ownEntry(await readLibrary(directory));
  return async () => {
    const library = await readLibrary(directory);
    const entry = ownEntry(library);
    if (foreign(entry)) return 'done';
    const state = await pluginInstallation(directory, owner);
    if (state !== 'removed') {
      absentSince = undefined;
      if (state === 'installed' && removing && !entry) { await restore(); removing = false; return 'installed'; }
      if (state === 'installed') removing = false;
      return !entry && !removing && state === 'installed' ? 'done' : state;
    }
    if (!entry && !pendingMcpRemoval(library)) return 'done';
    absentSince ??= now();
    if (now() - absentSince < graceMs) return 'waiting';
    removing = true;
    if (entry) {
      await remove(directory, definition, {
        magpie, shouldRemove: async () => await pluginInstallation(directory, owner) === 'removed',
      });
    }
    // 新 server() 可能在 rm 执行中复用旧条目；若此时已重装而条目刚被删除，恢复登记。
    const after = ownEntry(await readLibrary(directory));
    if (foreign(after)) return 'done';
    const current = await pluginInstallation(directory, owner);
    if (current !== 'removed') {
      absentSince = undefined;
      if (current === 'installed' && removing && !after) await restore();
      if (current === 'installed') removing = false;
      return current;
    }
    if (after) return 'waiting';
    if (pendingMcpRemoval(await readLibrary(directory))) await sync(directory, { magpie, shouldSync: canSync });
    const finalState = await pluginInstallation(directory, owner);
    if (finalState !== 'removed') {
      if (finalState === 'installed' && !ownEntry(await readLibrary(directory))) await restore();
      if (finalState === 'installed') removing = false;
      return finalState;
    }
    return pendingMcpRemoval(await readLibrary(directory)) ? 'waiting' : 'done';
  };
}

export async function watchForUninstall({ directory, definition, owner, magpie, pollMs = POLL_MS, graceMs = GRACE_MS }) {
  const socket = cleanupSocket(directory, definition);
  const server = await listen(socket);
  if (!server) return;
  // 普通 magpie CLI 和宿主会频繁退出，此进程只在安装列表明确移除插件时才清理。
  let watching, polling, scheduled, busy = false, stopped = false;
  const check = uninstallCheck({ directory, definition, owner, magpie, graceMs });
  let finish;
  const ended = new Promise(resolve => { finish = resolve; });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(polling); clearTimeout(scheduled); watching?.close();
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
    server.close(finish);
  };
  const inspect = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const result = await check();
      if (result === 'done') stop();
      else if (result === 'waiting') { clearTimeout(scheduled); scheduled = setTimeout(inspect, graceMs + 50); }
    } catch { /* 读失败或 magpie 同步失败时保留条目，下次轮询重试。 */ }
    finally { busy = false; }
  };
  try {
    watching = watch(directory, (_event, file) => {
      if (!file || ['plugins.json', 'library.json'].includes(String(file))) void inspect();
    });
    watching.on('error', () => { watching?.close(); watching = undefined; });
  } catch { /* 目录监听不可用时仍保留低频轮询。 */ }
  polling = setInterval(inspect, pollMs);
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  await inspect();
  await ended;
}

/** 加载扩展时自动调用；已运行的监视进程通过短连接复用，不创建系统服务或配置快照。 */
export async function startCleanupWatcher(input, definition, { launcher = process.execPath, magpie = locateMagpie } = {}) {
  const directory = await canonical(input.directory);
  const owner = await findPluginOwner(directory);
  // 直接 import 的开发检查没有安装记录，不启动后台进程。
  if (!owner) return { watching: false };
  const socket = cleanupSocket(directory, definition);
  if (await isWatching(socket)) return { watching: true };
  const executable = typeof magpie === 'function' ? await magpie() : magpie;
  const child = spawn(launcher, [fileURLToPath(import.meta.url), JSON.stringify({ directory, definition, owner, magpie: executable })], {
    detached: true, stdio: 'ignore', cwd: directory, env: process.env,
  });
  let failure;
  child.once('error', error => { failure = error; });
  child.unref();
  for (let attempt = 0; attempt < 30; attempt++) {
    if (failure) throw failure;
    if (await isWatching(socket)) return { watching: true };
    if (child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  child.kill('SIGTERM');
  throw new Error('无法启动卸载清理监视进程；请重新加载插件。');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  watchForUninstall(JSON.parse(process.argv[2])).catch(() => { process.exitCode = 1; });
}
