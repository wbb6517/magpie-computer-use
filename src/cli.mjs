import { randomUUID } from 'node:crypto';
import { loadOptions, status, runtimePaths } from './config.mjs';
import { prepareRuntime, verifyOfficialApp } from './bootstrap.mjs';

export function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift() || 'help';
  const values = {};
  while (args.length) {
    const flag = args.shift();
    if (['--json', '--help', '-h'].includes(flag)) { values[flag.replace(/^--?/, '')] = true; continue; }
    if (!['--config', '--app', '--surface'].includes(flag)) throw new Error(`未知参数：${flag}`);
    if (!args.length || args[0].startsWith('--')) throw new Error(`${flag} 缺少值。`);
    values[flag.slice(2)] = args.shift();
  }
  return { command, ...values };
}
export function assertRuntimeEnvironment(env = process.env) {
  if (env.LCU_ALLOW_AGENT_HOST_APPROVAL === '1') throw new Error('请移除 LCU_ALLOW_AGENT_HOST_APPROVAL=1；本插件不允许控制承载 Agent 的应用。');
  if (['off', 'disabled'].includes(env.LCU_NODE_REPL_SANDBOX?.toLowerCase())) throw new Error('本插件不启用关闭运行时沙箱的选项。');
}
async function requireRuntime(options) {
  const info = status(options);
  if (!info.supportedPlatform) throw new Error('此版本支持 Apple Silicon macOS。');
  if (!info.runtimePrepared) throw new Error('缺少本机 Codex 的完整 Computer Use 运行时，请更新官方桌面应用后重连 MCP。');
  if (!info.dependenciesInstalled) throw new Error('插件依赖不完整：请在 magpie 的扩展页面重新安装或更新本插件。');
  // 校验必须在当前可信 launcher 中完成，不能先执行候选包内的 Node 再让它自验。
  const { inspectRuntime } = await import('./gateway/entry.mjs');
  inspectRuntime(options.appPath);
  return runtimePaths(options);
}
// CLI 仅供 magpie 生成的 MCP 条目和开发诊断使用；用户从扩展页面安装。
const help = `magpie Computer Use · 内部入口与开发诊断\n\n请从 magpie“扩展”添加插件，MCP 会自动加入资源库。\n\n  mcp                    启动资源库条目调用的 stdio MCP\n  prepare                校验官方运行时\n  status [--json]        只读环境信息\n  doctor [--json]        原始运行时只读发现\n\n  --app /Applications/ChatGPT.app  仅开发诊断临时覆盖应用路径\n  --surface native|javascript   内部工具接口（默认十工具）\n`;
export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || args.h || ['help', '--help', '-h'].includes(args.command)) { process.stdout.write(help); return; }
  // --config 仅兼容 0.4 资源库 argv，不再读取其文件或沿用其中的覆盖设置。
  const loaded = loadOptions(args.app ? { options: { appPath: args.app } } : {});
  if (args.surface && !['native', 'javascript'].includes(args.surface)) throw new Error('--surface 必须是 native 或 javascript。');
  const options = loaded;
  if (args.command === 'status') { process.stdout.write(JSON.stringify(status(options), null, 2) + '\n'); return; }
  if (args.command === 'prepare') {
    assertRuntimeEnvironment();
    const info = await prepareRuntime(options, { onProgress: message => process.stderr.write(`${message}\n`) });
    process.stdout.write(JSON.stringify(info, null, 2) + '\n'); return;
  }
  if (args.command === 'mcp') {
    assertRuntimeEnvironment();
    const paths = await requireRuntime(options);
    const { runBridge } = await import('./bridge.mjs');
    const bridge = await runBridge({ toolSurface: args.surface || 'native', runtimeCommand: paths.runtimeCommand, clientModulePath: paths.clientModulePath,
      requestTimeoutMs: options.requestTimeoutMs, idleTimeoutMs: options.idleTimeoutMs });
    await bridge.closed; return;
  }
  if (args.command === 'doctor') {
    assertRuntimeEnvironment();
    const paths = await requireRuntime(options);
    await verifyOfficialApp(options.appPath);
    const { inspectRuntime } = await import('./gateway/entry.mjs');
    const runtime = await inspectRuntime(options.appPath);
    const { createCuaClient } = await import('../vendor/lcu-client/client.mjs');
    const client = createCuaClient({ command: paths.runtimeCommand, onElicitation: async () => ({ action: 'cancel' }) });
    const sessionId = `magpie-doctor-${randomUUID()}`;
    const turnId = `${sessionId}-check`;
    try {
      await client.connect();
      const result = await client.call('js', { code: 'const apps = await cua.listApps({emit: false}); nodeRepl.write({nativeAppService: true, appCount: apps.length});', timeout_ms: 20000 }, { sessionId, turnId });
      if (result.isError) throw new Error(result.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') || '原生应用发现失败');
      const text = result.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') || '';
      if (!/nativeAppService: true/.test(text)) throw new Error('原生应用发现未返回预期结果');
      const info = { ...status(options), originalAppSignatureVerified: true, runtime,
        runtimeTransportTools: client.publicTools().map(tool => tool.name), publicTools: (await import('./native-tools.mjs')).NATIVE_TOOLS.map(tool => tool.name), nativeDiscovery: { passed: true, appCount: Number(/appCount:\s*(\d+)/.exec(text)?.[1]) },
        appControlAttempted: false, permissionPromptsAutomaticallyApproved: 0 };
      await client.turnEnded({ sessionId, turnId, event: 'Stop' });
      process.stdout.write(JSON.stringify(info, null, 2) + '\n');
    } finally { await client.close(); }
    return;
  }
  throw new Error(`未知命令：${args.command}；用 --help 查看。`);
}
