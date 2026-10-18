import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeOptions, PROJECT_ROOT, PLUGIN_NAME } from './config.mjs';
import { run } from './process.mjs';

async function locateMagpie() {
  const candidates = [
    '/Applications/magpie.app/Contents/MacOS/magpie',
    path.join(process.env.HOMEBREW_PREFIX || '/opt/homebrew', 'bin/magpie'),
  ];
  for (const candidate of candidates) {
    try { await fs.access(candidate, 1); return candidate; } catch {}
  }
  throw new Error('找不到 magpie 可执行文件，无法将 Computer Use 加入资源库。');
}

function absolutePath(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\r\n\0]/.test(value)) {
    throw new Error(`${name} 必须是有效的绝对路径。`);
  }
  return path.resolve(value);
}

export function snapshotPath(directory) {
  return path.join(absolutePath(directory, 'magpie 配置目录'), 'plugins', PLUGIN_NAME, 'options.json');
}

export function libraryMcpDefinition(directory, launcher = process.execPath) {
  return {
    name: PLUGIN_NAME,
    transport: 'stdio',
    command: absolutePath(launcher, 'MCP 启动程序'),
    args: [path.join(PROJECT_ROOT, 'bin/magpie-computer-use.mjs'), 'mcp', '--config', snapshotPath(directory)],
    agents: [],
  };
}

async function readLibrary(directory) {
  const file = path.join(directory, 'library.json');
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value) || (value.mcp !== undefined && !Array.isArray(value.mcp))) {
      throw new Error('资源库应为对象，mcp 应为数组');
    }
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return { mcp: [] };
    throw new Error(`无法读取 magpie 资源库：${error.message}`);
  }
}

function sameDefinition(existing, definition) {
  return existing.transport === 'stdio' && existing.command === definition.command &&
    JSON.stringify(existing.args ?? []) === JSON.stringify(definition.args);
}

function checkExisting(existing, definition) {
  if (!existing || sameDefinition(existing, definition)) return;
  const ownCli = existing.transport === 'stdio' && existing.args?.[0] === definition.args[0] && existing.args?.[1] === 'mcp';
  if (ownCli) {
    throw new Error('magpie 资源库中已有本插件的旧版 MCP 配置。请在资源库编辑该条目，迁移到当前插件配置；原有 Agent 选择不会被自动覆盖。');
  }
  throw new Error(`magpie 资源库已有同名的其他 MCP（${PLUGIN_NAME}），插件不会覆盖它；请先在资源库检查或重命名。`);
}

async function writeSnapshot(file, options) {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('插件配置目录必须是本机普通目录，不能是符号链接。');
  await fs.chmod(directory, 0o700);
  const temporary = path.join(directory, `.options-${process.pid}-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(options, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, file);
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

// magpie 加载插件时仅登记本包的 MCP；不启动原始运行时，不发现应用或请求授权。
export async function ensureLibraryMcp(input, rawOptions, {
  runner = run,
  launcher = process.execPath,
  magpie = locateMagpie,
} = {}) {
  // 所有参数先验证，失败时不写入本机选项快照。
  const options = normalizeOptions(rawOptions);
  const directory = absolutePath(input?.directory, 'magpie 配置目录');
  const definition = libraryMcpDefinition(directory, launcher);
  const configFile = snapshotPath(directory);
  const library = await readLibrary(directory);
  const existing = library.mcp?.find(entry => entry?.name === PLUGIN_NAME);
  checkExisting(existing, definition);
  await writeSnapshot(configFile, options);
  if (existing) return { registered: true, created: false, configFile, definition };

  const executable = absolutePath(typeof magpie === 'function' ? await magpie() : magpie, 'magpie 启动程序');
  const env = { ...process.env };
  // 沿用宿主的实际配置根，确保官方 CLI 写入同一个用户或隔离测试实例。
  if (path.basename(directory) === 'magpie') env.XDG_CONFIG_HOME = path.dirname(directory);
  try {
    await runner(executable, ['library', 'mcp', 'add', PLUGIN_NAME, definition.command, ...definition.args, 'agents='], {
      cwd: directory, env, timeoutMs: 30_000,
    });
  } catch (error) {
    // 多个宿主可能同时加载。CLI 拒绝重名时，只接受另一宿主刚写入的相同定义。
    const concurrent = (await readLibrary(directory)).mcp?.find(entry => entry?.name === PLUGIN_NAME);
    if (!concurrent || !sameDefinition(concurrent, definition)) throw error;
    return { registered: true, created: false, configFile, definition };
  }
  const added = (await readLibrary(directory)).mcp?.find(entry => entry?.name === PLUGIN_NAME);
  if (!added || !sameDefinition(added, definition)) {
    throw new Error('magpie 未在当前配置目录登记 Computer Use MCP；请检查插件加载错误。');
  }
  return { registered: true, created: true, configFile, definition };
}
