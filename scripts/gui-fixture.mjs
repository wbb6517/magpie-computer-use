import fs from 'node:fs/promises';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

if (process.platform !== 'darwin') throw new Error('GUI fixture 仅支持 macOS，需要 Xcode Command Line Tools。');
const source = fileURLToPath(new URL('./fixtures/GuiFixture.swift', import.meta.url));
let temporary, child, owner, appStarted = false, stopped = false;
// 在创建目录和编译前安装处理器，构建中断也必须进入 finally 清理。
const stop = () => { stopped = true; if (owner) rmSync(owner, { force: true }); if (!appStarted) child?.kill('SIGTERM'); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
async function execute(command, args, env = process.env) {
  if (stopped) throw new Error('Fixture cancelled');
  child = spawn(command, args, { env, stdio: 'inherit' });
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  child = undefined;
  if (result.code !== 0 || result.signal) throw new Error(command + ' failed: ' + (result.signal ?? result.code));
}
try {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'magpie-cua-fixture-'));
  const app = path.join(temporary, 'Magpie Computer Use Test.app');
  const contents = path.join(app, 'Contents');
  const binary = path.join(contents, 'MacOS/fixture');
  const events = path.join(temporary, 'events.jsonl');
  owner = path.join(temporary, 'owner-alive');
  await fs.writeFile(owner, '', { mode: 0o600 });
  await fs.mkdir(path.dirname(binary), { recursive: true });
  await fs.writeFile(events, '', { mode: 0o600 });
  await fs.writeFile(path.join(contents, 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>fixture</string><key>CFBundleIdentifier</key><string>dev.magpie.computer-use-test</string><key>CFBundleName</key><string>Magpie Computer Use Test</string><key>CFBundlePackageType</key><string>APPL</string><key>NSHighResolutionCapable</key><true/></dict></plist>');
  // 编译和临时签名只作用于自有测试窗口，不触碰官方应用或 helper。
  await execute('xcrun', ['swiftc', '-module-cache-path', path.join(temporary, 'swift-cache'), source, '-o', binary]);
  await execute('codesign', ['--force', '--sign', '-', app]);
  console.log('测试应用绝对路径：' + app + '\n测试事件：' + events + '\n请将此路径交给 Agent；仅允许控制这个窗口，真实授权由用户完成。关闭窗口或按 Ctrl+C 后删除全部临时编译产物。');
  // 通过系统应用启动流程取得完整窗口输入上下文；直接执行二进制会缺少坐标输入窗口。
  appStarted = true;
  await execute('/usr/bin/open', ['-W', '-n', '-a', app, '--env', `MAGPIE_CUA_TEST_LOG=${events}`, '--env', `MAGPIE_CUA_TEST_OWNER=${owner}`]);
} catch (error) {
  if (!stopped) throw error;
} finally {
  child?.kill('SIGTERM');
  // 路径只来自 mkdtemp；不清理项目目录、用户文档或任何运行时安装。
  if (temporary) await fs.rm(temporary, { recursive: true, force: true });
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
}
