// magpie Computer Use 内置的 macOS 运行时启动入口。
// 启动、环境与生命周期设计改编自 LCU v0.11.4，采用 MIT 许可（Amont Labs）。
// 许可与来源见 LICENSE、SOURCES.md；直接使用原位置的 OpenAI 二进制，不修改其内容。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { locateCodexTools } from './app_layout.mjs';
import { readCodexRuntimeSettings, browserService } from '../codex-settings.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEAM = '2DC432GLL2';
const APP_ID = 'com.openai.codex';
const HELPER_ID = 'com.openai.sky.CUAService';
const SOCKET_ENV = 'SKY_CUA_SERVICE_NATIVE_PIPE_PATH';
const SOCKET_SUFFIX = `Library/Group Containers/${TEAM}.${HELPER_ID}/IPC/computeruse.sock`;
const unsafePath = /[\r\n\0]/;
function system(command, args, timeout = 30000) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed: ${(result.stderr || result.error?.message || result.stdout || String(result.status)).trim().slice(0, 500)}`);
  return result;
}
function plist(bundle, field) {
  return system('/usr/bin/plutil', ['-extract', field, 'raw', '-o', '-', path.join(bundle, 'Contents/Info.plist')]).stdout.trim();
}
// 同时核对应用标识与签名团队，再递归验证整个应用包；仅检查元数据无法确认嵌套组件完整。
function verifyBundle(bundle, identifier) {
  if (plist(bundle, 'CFBundleIdentifier') !== identifier) throw new Error(`Unexpected application identifier: ${bundle}`);
  const result = system('/usr/bin/codesign', ['-dv', '--verbose=2', bundle]);
  const lines = `${result.stdout}\n${result.stderr}`.split('\n');
  if (!lines.includes(`TeamIdentifier=${TEAM}`) || !lines.includes(`Identifier=${identifier}`)) throw new Error(`Application is not signed by OpenAI: ${bundle}`);
  system('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], 120000);
}
// 逐级拒绝符号链接，防止已选应用内部的路径实际指向包外或替换后的运行组件。
function regularWithin(root, file, executable = false) {
  const rel = path.relative(root, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Component outside selected app: ${file}`);
  let current = root;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    const info = fs.lstatSync(current);
    if (info.isSymbolicLink()) throw new Error(`Runtime component must not be redirected: ${current}`);
  }
  if (!fs.lstatSync(file).isFile()) throw new Error(`Required runtime file is missing: ${file}`);
  if (executable) fs.accessSync(file, fs.constants.X_OK);
}

/** 仅检查所选完整官方应用及辅助应用，并递归验证签名；此处不会启动它们。 */
export function inspectRuntime(appPath) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Embedded gateway supports Apple Silicon macOS.');
  if (typeof appPath !== 'string' || !path.isAbsolute(appPath) || unsafePath.test(appPath)) throw new Error('Official app path must be an absolute local path.');
  const info = fs.lstatSync(appPath);
  if (!info.isDirectory() || info.isSymbolicLink() || !appPath.endsWith('.app')) throw new Error('Select the complete original Codex desktop application bundle.');
  const app = fs.realpathSync(appPath);
  const resources = path.join(app, 'Contents/Resources');
  const runtimePath = path.join(resources, 'cua_node');
  const nodePath = path.join(runtimePath, 'bin/node');
  const nodeReplPath = path.join(runtimePath, 'bin/node_repl');
  const entryPath = path.join(runtimePath, 'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs');
  const helperPath = path.join(runtimePath, 'lib/node_modules/@oai/sky/Codex Computer Use.app');
  const clientPath = path.join(helperPath, 'Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient');
  const skyPath = path.join(runtimePath, 'lib/node_modules/@oai/sky/dist/project/cua/sky_js/src');
  const servicePath = path.join(skyPath, 'service.js');
  const macClientPath = path.join(skyPath, 'targets/mac/client.js');
  for (const file of [nodePath, nodeReplPath, clientPath]) regularWithin(app, file, true);
  for (const file of [entryPath, servicePath, macClientPath, path.join(runtimePath, 'manifest.json')]) regularWithin(app, file);
  const manifest = JSON.parse(fs.readFileSync(path.join(runtimePath, 'manifest.json'), 'utf8'));
  if (manifest.platform !== 'darwin' || manifest.arch !== 'arm64' || typeof manifest.runtime_archive_version !== 'string' || !manifest.runtime_archive_version) throw new Error('Original CUA runtime manifest is incompatible.');
  verifyBundle(app, APP_ID);
  verifyBundle(helperPath, HELPER_ID);
  const tools = locateCodexTools(resources);
  regularWithin(app, tools.cli, true); regularWithin(app, tools.codeModeHost, true);
  return { app, appVersion: plist(app, 'CFBundleShortVersionString'), runtimeVersion: manifest.runtime_archive_version,
    runtimePath, resources, nodePath, nodeReplPath, entryPath, helperPath, clientPath, servicePath, macClientPath,
    codexCli: tools.cli, codeModeHost: tools.codeModeHost, originalSignatureVerified: true };
}

/** 为已验证应用与内置网关生成确定的路径；不查找或调用外部 LCU 可执行文件。 */
export function runtimeEnvironment(runtime, { chrome = false, env: source = process.env } = {}) {
  if (source.LCU_ALLOW_AGENT_HOST_APPROVAL === '1') throw new Error('Agent-host approval bypass is not supported.');
  if (['off', 'disabled'].includes(source.LCU_NODE_REPL_SANDBOX?.toLowerCase())) throw new Error('Disabling the original sandbox is not supported.');
  const native = readCodexRuntimeSettings({ env: source });
  const env = { ...native.environment, ...source };
  env.CODEX_HOME = native.codexHome;
  const moduleDir = path.join(runtime.runtimePath, 'lib/node_modules');
  // 原生服务使用系统报告的当前账户目录；调用方覆盖 HOME 时也不能据此推断账户 IPC 目录。
  const accountHome = os.userInfo().homedir;
  const wrapper = path.join(HERE, 'macos_sky_service.mjs');
  const configuredBrowser = browserService(source.NODE_REPL_TRUSTED_SERVICES) ?? native.browserService;
  const browser = configuredBrowser && (!path.isAbsolute(configuredBrowser) || fs.existsSync(configuredBrowser))
    ? configuredBrowser : '@oai/browser-desktop/service';
  const services = { sky: wrapper, ...(chrome ? { browser } : {}) };
  const unique = values => [...new Set(values.filter(Boolean))].join(':');
  Object.assign(env, {
    PATH: `${path.join(runtime.runtimePath, 'bin')}:${source.PATH || '/usr/bin:/bin'}`,
    CUA_REPL_NODE_REPL_PATH: runtime.nodeReplPath, NODE_REPL_NODE_PATH: runtime.nodePath,
    NODE_REPL_NODE_MODULE_DIRS: unique([moduleDir, ...(source.NODE_REPL_NODE_MODULE_DIRS || '').split(':')]),
    NODE_REPL_TRUSTED_CODE_PATHS: unique([HERE, env.CODEX_HOME, moduleDir, path.join(runtime.resources, 'plugins'), ...(source.NODE_REPL_TRUSTED_CODE_PATHS || '').split(':')]),
    NODE_REPL_TRUSTED_SERVICES: JSON.stringify(services), CUA_REPL_ENABLED_SURFACES: chrome ? 'browser,computer' : 'computer',
    CUA_REPL_BROWSER_ENV: 'codex-app', CODEX_CLI_PATH: runtime.codexCli, SKY_CUA_SERVICE_PATH: runtime.helperPath,
    LCU_MAC_SKY_SERVICE_PATH: runtime.servicePath, LCU_MAC_SKY_CLIENT_PATH: runtime.macClientPath,
    NODE_REPL_DISABLE_ANALYTICS: '1', BROWSER_USE_DISABLE_AMBIENT_NETWORK: '1',
    NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS: env.NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS || '1000',
    BROWSER_USE_CODEX_APP_VERSION: runtime.appVersion,
  });
  // 连接启动时提供默认元数据；后续工具调用由共享客户端写入宿主传入的会话与轮次身份。
  if (!('NODE_REPL_REQUEST_META' in env)) {
    const identity = `magpie-gateway-${randomUUID()}`;
    env.NODE_REPL_REQUEST_META = JSON.stringify({ 'x-codex-turn-metadata': { session_id: identity, turn_id: `${identity}-connection` } });
  }
  const socketPath = env[SOCKET_ENV] || path.join(accountHome, SOCKET_SUFFIX);
  if (Buffer.byteLength(socketPath) > 103) throw new Error('Original Computer Use helper socket path exceeds the macOS path limit.');
  const clientHome = 'HOME' in env ? env.HOME : accountHome;
  let sameHome = false;
  try { sameHome = fs.realpathSync(clientHome) === fs.realpathSync(accountHome); } catch {}
  // 只有默认账户套接字及相同 HOME 才能确定锁的归属，避免对自定义服务路径发起错误恢复。
  if (SOCKET_ENV in env || !sameHome) delete env.LCU_MAC_SERVICE_LOCK;
  else env.LCU_MAC_SERVICE_LOCK = `${socketPath}.lock`;
  return env;
}
export function parseGatewayArgs(argv) {
  const args = [...argv]; let appPath; let chrome = false;
  while (args.length) {
    const flag = args.shift();
    if (flag === '--app' && appPath === undefined && args.length) { appPath = args.shift(); continue; }
    if (flag === '--chrome' && !chrome) { chrome = true; continue; }
    throw new Error(`Unknown or duplicate gateway option: ${flag}`);
  }
  if (!appPath) throw new Error('Gateway requires --app /absolute/path/ChatGPT.app');
  return { appPath, chrome };
}

/** 为当前这条连接管理原始 MCP 进程与内置原生生命周期宿主。 */
export async function main(argv = process.argv.slice(2)) {
  const { appPath, chrome } = parseGatewayArgs(argv);
  const runtime = inspectRuntime(appPath);
  const env = runtimeEnvironment(runtime, { chrome });
  const { startOriginalHost } = await import('./macos_host.mjs');
  const host = await startOriginalHost({ client: runtime.clientPath, env });
  env.LCU_MAC_LIFETIME_SOCKET = host.address;
  let child, killTimer;
  // 将中断传给原始进程，并留出退出余量；逾期才强制结束，随后统一关闭生命周期宿主。
  const signal = name => {
    child?.kill(name);
    killTimer ??= setTimeout(() => child?.kill('SIGKILL'), 10000);
    killTimer.unref();
  };
  const terminate = () => signal('SIGTERM');
  const interrupt = () => signal('SIGINT');
  try {
    const code = await new Promise((resolve, reject) => {
      child = spawn(runtime.nodePath, [runtime.entryPath], { env, stdio: 'inherit' });
      child.once('error', reject);
      child.once('close', (code, signal) => resolve(code ?? 128 + (os.constants.signals[signal] || 0)));
      process.on('SIGTERM', terminate); process.on('SIGINT', interrupt);
    });
    return code;
  } finally {
    clearTimeout(killTimer);
    process.off('SIGTERM', terminate); process.off('SIGINT', interrupt);
    // 正常退出、启动失败和信号退出都必须清理未结束轮次及私有套接字。
    await host.stop();
  }
}
const isMain = process.argv[1] && pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url;
if (isMain) {
  try { process.exitCode = await main(); }
  catch (error) { process.stderr.write(`magpie Computer Use gateway: ${error.message}\n`); process.exitCode = 1; }
}
