/**
 * 工作流 ②b：读取本机 Codex 的 config.toml，提取启动所需的非凭据字段。
 * 这不是应用授权存储：持久应用批准仍由后面启动的官方 node_repl 自行判断。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';

// 只同步运行时的非凭据配置；绝不复制其他聊天的访问执行器、签名身份或授权 pipe。
const RUNTIME_KEYS = [
  'BROWSER_USE_AVAILABLE_BACKENDS', 'BROWSER_USE_BACKEND_PATHS', 'BROWSER_USE_TINYSKY_ENABLED',
  'BROWSER_USE_CODEX_APP_BUILD_FLAVOR', 'NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS',
  'SKY_CUA_SERVICE_NATIVE_PIPE_PATH',
];
const safeString = value => typeof value === 'string' && !/[\r\n\0]/.test(value);

/** 缺少配置时交给原始运行时使用默认值；配置损坏则明确报错，避免默默换一套设置。 */
export function readCodexRuntimeSettings({ env = process.env, home = os.userInfo().homedir, read = file => fs.readFileSync(file, 'utf8') } = {}) {
  const codexHome = env.CODEX_HOME || path.join(home, '.codex');
  if (!safeString(codexHome) || !path.isAbsolute(codexHome)) throw new Error('CODEX_HOME 必须是本机绝对路径。');
  let config;
  try {
    const source = read(path.join(codexHome, 'config.toml'));
    if (Buffer.byteLength(source) > 1024 * 1024) throw new Error('configuration exceeds size limit');
    config = parse(source);
  } catch (error) {
    if (error.code === 'ENOENT') return { codexHome, environment: {} };
    // 不把配置原文或 parser 摘录带入错误，避免意外暴露同一文件中的账号信息。
    throw new Error('无法读取本机 Codex 的 config.toml，请先在 Codex 中修复配置后重连 MCP。');
  }
  // 只提取原生 node_repl 的运行参数；其他 MCP、模型、供应商及账号设置均不传入子进程。
  const native = config.mcp_servers?.node_repl?.env ?? {};
  const environment = {};
  for (const key of RUNTIME_KEYS) if (safeString(native[key])) environment[key] = native[key];
  const codexCli = safeString(native.CODEX_CLI_PATH) ? native.CODEX_CLI_PATH : undefined;
  return { codexHome, environment, codexCli, browserService: browserService(native.NODE_REPL_TRUSTED_SERVICES) };
}

// 本机 Codex 生成的 trusted-services 表中只取 browser 项；sky 仍经过本扩展的生命周期包装。
export function browserService(raw) {
  if (typeof raw !== 'string') return undefined;
  try {
    const value = JSON.parse(raw)?.browser;
    return safeString(value) && (path.isAbsolute(value) || value === '@oai/browser-desktop/service') ? value : undefined;
  } catch { return undefined; }
}
