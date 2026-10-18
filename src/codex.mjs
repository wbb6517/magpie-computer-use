import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const BUNDLE_ID = 'com.openai.codex';
const unsafe = /[\r\n\0]/;

// 只提取完整应用包的根目录，不把单独复制的 Node/helper 当作 Codex 安装。
function containingApp(value) {
  if (typeof value !== 'string' || unsafe.test(value) || !path.isAbsolute(value)) return undefined;
  const marker = '.app/Contents/';
  const index = value.indexOf(marker);
  return index < 0 ? undefined : value.slice(0, index + 4);
}

function run(runner, command, args) {
  try {
    const result = runner(command, args, { encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    return result.status === 0 ? result.stdout.trim() : '';
  } catch { return ''; }
}

// 发现阶段只检查身份元数据和所需组件；执行前仍由网关递归验证官方签名。
export function isCodexInstallation(app, { runner = spawnSync } = {}) {
  if (typeof app !== 'string' || !path.isAbsolute(app) || unsafe.test(app) || !app.endsWith('.app')) return false;
  try {
    const info = fs.lstatSync(app);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    const resources = path.join(app, 'Contents/Resources');
    if (!fs.statSync(path.join(resources, 'cua_node/bin/node')).isFile() ||
        !fs.statSync(path.join(resources, 'cua_node/bin/node_repl')).isFile()) return false;
    return run(runner, '/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(app, 'Contents/Info.plist')]) === BUNDLE_ID;
  } catch { return false; }
}

/** 每次 MCP 启动重新发现，避免应用移动或更新后继续使用旧的路径快照。 */
export function discoverCodexApp({
  env = process.env, executable = process.execPath, home = os.userInfo().homedir,
  runner = spawnSync, probe = app => isCodexInstallation(app, { runner }),
} = {}) {
  const first = values => [...new Set(values.filter(Boolean))].find(probe);
  const inherited = first([containingApp(env.CODEX_CLI_PATH), containingApp(executable)]);
  if (inherited) return inherited;

  // comm 只包含可执行路径，不读取其他进程的参数、环境或会话凭据。
  const processes = run(runner, '/bin/ps', ['-axo', 'comm=']).split('\n');
  const running = [...new Set(processes.map(value => containingApp(value.trim())).filter(Boolean))].filter(probe);
  if (running.length > 1) throw new Error('同时运行了多份 Codex 安装；请保留需要使用的一份后重连 MCP。');
  if (running.length === 1) return running[0];

  const applications = ['/Applications', path.join(home, 'Applications')];
  const known = applications.flatMap(directory => ['Codex.app', 'ChatGPT.app'].map(name => path.join(directory, name)));
  const standard = first(known);
  if (standard) return standard;

  // 同时支持重命名或非默认位置的正式应用；Spotlight 不可用时仍有标准目录回退。
  const indexed = run(runner, '/usr/bin/mdfind', [`kMDItemCFBundleIdentifier == "${BUNDLE_ID}"`]).split('\n');
  const relocated = first(indexed);
  if (relocated) return relocated;
  throw new Error('未找到包含 Computer Use 运行时的本机 Codex。请安装或更新完整官方桌面应用后重连 MCP。');
}
