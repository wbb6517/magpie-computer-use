import { ensureLibraryMcp } from './src/library.mjs';

function createPlugin(dependencies) {
  return {
    id: 'magpie-computer-use',
    async server(input, options) {
      // 插件加载即登记资源库；Agent 选择和配置分发交给 magpie，MCP 保留图片与授权。
      await ensureLibraryMcp(input, options, dependencies);
      return {};
    },
  };
}

// 辅助函数放在对象内，避免 magpie 将命名导出误识别为额外插件入口。
export const _internal = Object.freeze({ createPlugin });
export default createPlugin();
