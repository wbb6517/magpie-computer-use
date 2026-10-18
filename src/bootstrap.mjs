import fs from 'node:fs/promises';
import { runtimePaths, status } from './config.mjs';
import { run } from './process.mjs';

export async function verifyOfficialApp(appPath, { runner = run } = {}) {
  const signature = await runner('/usr/bin/codesign', ['-dv', '--verbose=2', appPath], { timeoutMs: 30000 });
  if (!/(?:^|\n)TeamIdentifier=2DC432GLL2(?:\n|$)/.test(signature.stderr + signature.stdout)) throw new Error('所选应用不是 OpenAI 签名的官方 Codex 桌面应用。');
  await runner('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { timeoutMs: 60000 });
}
export async function prepareRuntime(options, { onProgress = () => {}, runner = run } = {}) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('此版本支持 Apple Silicon macOS。');
  const { gatewayPath, nodePath } = runtimePaths(options);
  onProgress('校验本机官方 Codex 桌面应用 与内置网关…');
  await verifyOfficialApp(options.appPath, { runner });
  await fs.access(gatewayPath);
  await fs.access(nodePath, 1);
  const { inspectRuntime } = await import('./gateway/entry.mjs');
  const runtime = await inspectRuntime(options.appPath);
  onProgress('内置网关就绪，无需下载或安装 LCU。');
  return { ...status(options), originalAppSignatureVerified: true, runtime };
}
