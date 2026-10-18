/** 工作流 ②：把发现、配置读取和路径组装连接起来，为 CLI 提供一次启动所需的信息。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { discoverCodexApp } from './codex.mjs';
import { readCodexRuntimeSettings } from './codex-settings.mjs';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PLUGIN_NAME = 'magpie-computer-use';
export const VERSION = '0.5.0';
// 仅为 MCP 传输保留内部预算，不再作为独立插件选项暴露或持久化。
export const DEFAULTS = Object.freeze({ requestTimeoutMs: 120000, idleTimeoutMs: 300000 });

// 只供内部开发诊断覆盖路径；普通扩展启动不读取旧选项或用户填写的路径。
export function normalizeOptions(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('运行选项必须是对象。');
  const { appPath } = input;
  if (typeof appPath !== 'string' || /[\r\n\0]/.test(appPath) || !path.isAbsolute(appPath)) throw new Error('运行时路径必须是字符串绝对路径。');
  const app = path.normalize(appPath);
  const browser = path.join(app, 'Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/package.json');
  return { appPath: app, chrome: fs.existsSync(browser), ...DEFAULTS };
}

/** 组合本机 Codex 的配置与发现结果；不加载旧版插件的 options.json。 */
export function loadOptions({ options, env = process.env, discover = discoverCodexApp } = {}) {
  if (options) return normalizeOptions(options);
  // 先取运行参数白名单，再把本机配置中的 CLI 路径作为发现线索；当前进程环境优先。
  const native = readCodexRuntimeSettings({ env });
  return normalizeOptions({ appPath: discover({ env: { ...native.environment, ...(native.codexCli ? { CODEX_CLI_PATH: native.codexCli } : {}), ...env } }) });
}

/** 这里只组装 argv，不执行其中的 Node；执行前校验由 cli.requireRuntime() 完成。 */
export function runtimePaths(options) {
  const nodePath = path.join(options.appPath, 'Contents/Resources/cua_node/bin/node');
  const gatewayPath = path.join(PROJECT_ROOT, 'src/gateway/entry.mjs');
  return { nodePath, gatewayPath,
    // 使用官方包内 Node 运行本包的网关入口，网关再启动官方 cua-repl。
    runtimeCommand: [nodePath, gatewayPath, '--app', options.appPath, ...(options.chrome ? ['--chrome'] : [])],
    clientModulePath: path.join(PROJECT_ROOT, 'vendor/lcu-client/client.mjs'),
    cliPath: path.join(PROJECT_ROOT, 'bin/magpie-computer-use.mjs') };
}
export function status(options) {
  const paths = runtimePaths(options);
  const executable = file => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; } };
  // npm/Bun 允许把依赖提升到父目录，按模块解析规则定位，不假定包内有 node_modules。
  let dependenciesInstalled = false;
  try { dependenciesInstalled = fs.existsSync(createRequire(import.meta.url).resolve('@modelcontextprotocol/sdk/client/index.js')); } catch {}
  return { plugin: PLUGIN_NAME, version: VERSION, backend: 'embedded-gateway', externalLcuRequired: false,
    configuration: 'automatic-local-codex',
    platform: `${process.platform}-${process.arch}`, supportedPlatform: process.platform === 'darwin' && process.arch === 'arm64',
    appPath: options.appPath, appExists: fs.existsSync(options.appPath), gatewayPath: paths.gatewayPath,
    runtimePrepared: fs.existsSync(paths.gatewayPath) && executable(paths.nodePath), originalNodeAvailable: executable(paths.nodePath), dependenciesInstalled,
    browserServiceAvailable: options.chrome,
    lifecycle: 'One isolated runtime per MCP connection; original Codex persisted app approvals and host turn metadata are preserved' };
}
