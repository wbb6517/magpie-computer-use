import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

export function loadOptions({ options, env = process.env, discover = discoverCodexApp } = {}) {
  if (options) return normalizeOptions(options);
  const native = readCodexRuntimeSettings({ env });
  return normalizeOptions({ appPath: discover({ env: { ...native.environment, ...(native.codexCli ? { CODEX_CLI_PATH: native.codexCli } : {}), ...env } }) });
}

export function runtimePaths(options) {
  const nodePath = path.join(options.appPath, 'Contents/Resources/cua_node/bin/node');
  const gatewayPath = path.join(PROJECT_ROOT, 'src/gateway/entry.mjs');
  return { nodePath, gatewayPath,
    runtimeCommand: [nodePath, gatewayPath, '--app', options.appPath, ...(options.chrome ? ['--chrome'] : [])],
    clientModulePath: path.join(PROJECT_ROOT, 'vendor/lcu-client/client.mjs'),
    cliPath: path.join(PROJECT_ROOT, 'bin/magpie-computer-use.mjs') };
}
export function status(options) {
  const paths = runtimePaths(options);
  const executable = file => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; } };
  const sdk = path.join(PROJECT_ROOT, 'node_modules/@modelcontextprotocol/sdk/package.json');
  return { plugin: PLUGIN_NAME, version: VERSION, backend: 'embedded-gateway', externalLcuRequired: false,
    configuration: 'automatic-local-codex',
    platform: `${process.platform}-${process.arch}`, supportedPlatform: process.platform === 'darwin' && process.arch === 'arm64',
    appPath: options.appPath, appExists: fs.existsSync(options.appPath), gatewayPath: paths.gatewayPath,
    runtimePrepared: fs.existsSync(paths.gatewayPath) && executable(paths.nodePath), originalNodeAvailable: executable(paths.nodePath), dependenciesInstalled: fs.existsSync(sdk),
    browserServiceAvailable: options.chrome,
    lifecycle: 'One isolated runtime per MCP connection; original Codex persisted app approvals and host turn metadata are preserved' };
}
