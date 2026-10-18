/**
 * 工作流入口 ①：magpie 加载扩展时调用 server()，先把 MCP 登记到资源库。
 * 此时不启动 Computer Use；用户选好 Agent 后，由该 Agent 启动登记的命令。
 * 继续阅读 src/library.mjs → bin/magpie-computer-use.mjs → src/cli.mjs。
 */
import { ensureLibraryMcp } from './src/library.mjs';
import { startCleanupWatcher } from './src/cleanup.mjs';

function createPlugin(dependencies) {
  return {
    id: 'magpie-computer-use',
    async server(input, options) {
      // 插件加载即登记资源库；Agent 选择和配置分发交给 magpie，MCP 保留图片与授权。
      const { definition } = await ensureLibraryMcp(input, options, dependencies);
      // 监视安装记录而非宿主退出；正常移除扩展后自动撤销本插件的 MCP 分发。
      await startCleanupWatcher(input, definition, dependencies);
      // 返回空的插件钩子集合：工具由资源库中的独立 MCP 连接提供。
      return {};
    },
  };
}

// 辅助函数放在对象内，避免 magpie 将命名导出误识别为额外插件入口。
export const _internal = Object.freeze({ createPlugin });
export default createPlugin();
