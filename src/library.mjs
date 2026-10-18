/**
 * 工作流 ①：资源库登记。保存的是 MCP 启动方式，不是正在运行的 Computer Use 服务。
 * ensureLibraryMcp() 可重复调用；同名且属于本插件的定义复用，无关同名定义报错。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_ROOT, PLUGIN_NAME } from './config.mjs';
import { run } from './process.mjs';

export async function locateMagpie() {
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

// 仅用于识别本插件旧版本的精确参数，不创建、读取或删除该文件。
export function snapshotPath(directory) {
  return path.join(absolutePath(directory, 'magpie 配置目录'), 'plugins', PLUGIN_NAME, 'options.json');
}

/** 生成 Agent 将来执行的命令；launcher 是加载扩展的 magpie Bun，路径不依赖用户 shell 的 Node。 */
export function libraryMcpDefinition(directory, launcher = process.execPath) {
  absolutePath(directory, 'magpie 配置目录');
  return {
    name: PLUGIN_NAME,
    transport: 'stdio',
    command: absolutePath(launcher, 'MCP 启动程序'),
    args: [path.join(PROJECT_ROOT, 'bin/magpie-computer-use.mjs'), 'mcp'],
    // 首次登记不替用户选择 Agent；后续在 magpie 资源库中分发。
    agents: [],
  };
}

export async function readLibrary(directory) {
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

export function acceptedDefinition(existing, definition, directory) {
  if (existing?.transport !== 'stdio' || existing.command !== definition.command) return false;
  const args = existing.args ?? [];
  if (JSON.stringify(args) === JSON.stringify(definition.args)) return true;
  // 旧版固定快照参数由 CLI 兼容接受并忽略。保持资源库条目原样，
  // 从而保留用户选择、禁用工具和所有其他字段，无需 remove/add。
  return Array.isArray(args) && args.length === 4 && args[0] === definition.args[0] &&
    args[1] === 'mcp' && args[2] === '--config' && args[3] === snapshotPath(directory);
}

function checkExisting(existing, definition, directory) {
  if (!existing || acceptedDefinition(existing, definition, directory)) return;
  throw new Error(`magpie 资源库已有同名的其他或自定义 MCP（${PLUGIN_NAME}），插件不会覆盖它；请先在资源库检查或重命名。`);
}

// 插件加载只登记无设置的 MCP。旧 rawOptions 不再参与运行时选择，
// 不写私有配置，不启动运行时或请求应用授权。
export async function ensureLibraryMcp(input, _rawOptions, {
  runner = run,
  launcher = process.execPath,
  magpie = locateMagpie,
} = {}) {
  const directory = absolutePath(input?.directory, 'magpie 配置目录');
  const definition = libraryMcpDefinition(directory, launcher);
  const library = await readLibrary(directory);
  const existing = library.mcp?.find(entry => entry?.name === PLUGIN_NAME);
  checkExisting(existing, definition, directory);
  // 已有兼容条目直接复用，因此不会改写 Agent 选择、禁用工具或其他用户字段。
  if (existing) return { registered: true, created: false, definition };

  const executable = absolutePath(typeof magpie === 'function' ? await magpie() : magpie, 'magpie 启动程序');
  const env = { ...process.env };
  // 沿用宿主的实际配置根，确保官方 CLI 写入同一个用户或隔离测试实例。
  if (path.basename(directory) === 'magpie') env.XDG_CONFIG_HOME = path.dirname(directory);
  try {
    // 通过 magpie 自身的资源库接口写入，而不是逐个修改 Claude/Codex 等客户端配置。
    await runner(executable, ['library', 'mcp', 'add', PLUGIN_NAME, definition.command, ...definition.args, 'agents='], {
      cwd: directory, env, timeoutMs: 30_000,
    });
  } catch (error) {
    // 多个宿主同时加载时，只接受另一个宿主刚写出的本插件已知定义。
    const concurrent = (await readLibrary(directory)).mcp?.find(entry => entry?.name === PLUGIN_NAME);
    if (!acceptedDefinition(concurrent, definition, directory)) throw error;
    return { registered: true, created: false, definition };
  }
  const added = (await readLibrary(directory)).mcp?.find(entry => entry?.name === PLUGIN_NAME);
  if (!acceptedDefinition(added, definition, directory)) {
    throw new Error('magpie 未在当前配置目录登记 Computer Use MCP；请检查插件加载错误。');
  }
  return { registered: true, created: true, definition };
}

/** 卸载时只移除仍指向本包的条目；通过 magpie 同步撤销 Agent 配置并保留其原生备份。 */
export async function removeLibraryMcp(directory, definition, {
  runner = run, magpie = locateMagpie, shouldRemove = async () => true,
} = {}) {
  const existing = (await readLibrary(directory)).mcp?.find(entry => entry?.name === PLUGIN_NAME);
  if (!acceptedDefinition(existing, definition, directory)) return false;
  const executable = absolutePath(typeof magpie === 'function' ? await magpie() : magpie, 'magpie 启动程序');
  // 解析命令可能耗时；实际移除前再核对安装状态和条目归属，避免常见的重新安装竞争。
  if (!await shouldRemove()) return false;
  const current = (await readLibrary(directory)).mcp?.find(entry => entry?.name === PLUGIN_NAME);
  if (!acceptedDefinition(current, definition, directory)) return false;
  const env = { ...process.env };
  if (path.basename(directory) === 'magpie') env.XDG_CONFIG_HOME = path.dirname(directory);
  await runner(executable, ['library', 'mcp', 'rm', PLUGIN_NAME], { cwd: directory, env, timeoutMs: 30_000 });
  const remaining = (await readLibrary(directory)).mcp?.find(entry => entry?.name === PLUGIN_NAME);
  if (acceptedDefinition(remaining, definition, directory)) throw new Error('magpie 未移除本插件的 MCP；稍后重试。');
  return true;
}

/** magpie 在客户端写入失败时仍可能返回 0；持有账本只有成功撤销后才去掉名称。 */
export function pendingMcpRemoval(library) {
  const hasName = names => Array.isArray(names) && names.includes(PLUGIN_NAME);
  return Object.values(library.applied ?? {}).some(agent => hasName(agent?.mcp)) ||
    (library.projects ?? []).some(project => Object.values(project.wrote ?? {}).some(hasName));
}

export async function syncMcpRemoval(directory, { runner = run, magpie = locateMagpie, shouldSync = async () => true } = {}) {
  const executable = absolutePath(typeof magpie === 'function' ? await magpie() : magpie, 'magpie 启动程序');
  if (!await shouldSync()) return;
  const env = { ...process.env };
  if (path.basename(directory) === 'magpie') env.XDG_CONFIG_HOME = path.dirname(directory);
  await runner(executable, ['library', 'sync'], { cwd: directory, env, timeoutMs: 30_000 });
}
