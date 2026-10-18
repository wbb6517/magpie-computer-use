import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PLUGIN_NAME = 'magpie-computer-use';
export const VERSION = '0.4.0';
export const DEFAULTS = Object.freeze({ appPath: '/Applications/ChatGPT.app', chrome: false, requestTimeoutMs: 120000, idleTimeoutMs: 300000 });
const expandHome = value => value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
const bounded = (value, fallback, min, max, name) => {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} 必须是 ${min}–${max} 之间的整数。`);
  return value;
};
export function normalizeOptions(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('插件选项必须是对象。');
  const rawApp = input.appPath ?? DEFAULTS.appPath;
  if (typeof rawApp !== 'string' || /[\r\n\0]/.test(rawApp)) throw new Error('运行时路径必须是有效的字符串绝对路径。');
  const appPath = expandHome(rawApp);
  if (!path.isAbsolute(appPath)) throw new Error('appPath 必须是绝对路径。');
  if (input.chrome !== undefined && typeof input.chrome !== 'boolean') throw new Error('chrome 必须是布尔值。');
  return { appPath: path.normalize(appPath), chrome: input.chrome === true,
    requestTimeoutMs: bounded(input.requestTimeoutMs, DEFAULTS.requestTimeoutMs, 30000, 600000, 'requestTimeoutMs'),
    idleTimeoutMs: bounded(input.idleTimeoutMs, DEFAULTS.idleTimeoutMs, 60000, 1800000, 'idleTimeoutMs') };
}
export function magpieConfigDir(env = process.env) {
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'magpie');
}
export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw new Error(`无法读取 ${file}：${error.message}`); }
}
// MCP 从插件加载时写出的稳定快照读取设置，不猜测 npm/GitHub 安装 spec。
export function loadOptions({ options, configFile, env = process.env } = {}) {
  if (options) return normalizeOptions(options);
  const file = configFile ? path.resolve(configFile) : path.join(magpieConfigDir(env), 'plugins', PLUGIN_NAME, 'options.json');
  return normalizeOptions(readJson(file, configFile ? undefined : {}));
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
    platform: `${process.platform}-${process.arch}`, supportedPlatform: process.platform === 'darwin' && process.arch === 'arm64',
    appPath: options.appPath, appExists: fs.existsSync(options.appPath), gatewayPath: paths.gatewayPath,
    runtimePrepared: fs.existsSync(paths.gatewayPath) && executable(paths.nodePath), originalNodeAvailable: executable(paths.nodePath), dependenciesInstalled: fs.existsSync(sdk),
    chrome: options.chrome, requestTimeoutMs: options.requestTimeoutMs, idleTimeoutMs: options.idleTimeoutMs,
    lifecycle: 'One isolated runtime per MCP connection; host turn metadata is preserved when supplied' };
}
