# magpie Computer Use

magpie 的 Computer Use 扩展，自动识别本机 Codex，沿用官方运行时、原生服务和已持久保存的应用批准，向所选 Agent 提供十个 macOS 操作工具。

**0.5.0 尚未发布，尚未进入官方精选。** 当前可从 magpie“扩展”添加项目本地目录。没有独立设置页，不需要填写应用路径、管理第二套应用授权或自行配置 MCP。

## 使用条件

- 已安装 magpie，使用 Apple Silicon macOS（`darwin-arm64`）。
- 本机有完整、签名有效且包含 Computer Use 组件的官方 Codex 桌面应用：`cua_node`、`node_repl`、`cua-repl` 和签名 helper。部分安装名为 `ChatGPT.app`，重命名的完整 `.app` 也可识别；判断依据是官方身份和组件，不只是显示名称。
- 所选 Agent 能使用 magpie 分发的 stdio MCP。截图显示和新的应用授权询问取决于 Agent 能力。

插件直接使用本机安装，不下载、复制、修改或重新签名 OpenAI 二进制，也不需要额外安装 LCU。普通用户无需安装 Node；Node.js 24+ 仅用于开发检查。

## 添加与使用

1. 在 magpie“扩展”添加本项目的本地目录并启用。
2. 到 **资源库 → MCP 服务器** 找到自动登记的 `magpie-computer-use`。
3. 选择要使用的 Agent，或点击“全部”；检测工具，默认应列出十个操作。
4. 重连所选 Agent 或新开会话，先调用 `list_apps`，再对目标调用 `get_app_state`。

每次 MCP 启动都会重新发现 Codex。若多份完整应用同时运行且无法确定来源，插件报错，由用户保留所需的一份后重连；不会随意选取其他会话。完整步骤见 [使用指南](docs/USAGE.md)。

## 授权如何沿用

当前 Codex 原始运行时与桌面端的 **Always-allowed apps** 共用同一账户的持久应用批准。插件调用原始运行时，由其判断是否已有批准；插件不自行读取批准清单或伪造 `accept`。这条原始调用链已静态核对，0.5 本轮尚未做持久批准端到端 GUI 验收。

新应用或仅有其他会话临时批准的应用，仍可能产生原始 MCP elicitation，由用户回答。不支持询问的 Agent 无法完成新的批准。macOS 辅助功能、屏幕录制及原生进程认证仍由官方组件和系统处理。插件不读取 `auth.json`、钥匙串或登录 token。

## 十个工具

| 工具 | 用途 |
| --- | --- |
| `list_apps` | 发现应用 |
| `get_app_state` | 获取目标界面树、截图并触发必要的原始授权 |
| `click` | 按元素索引或截图坐标点击 |
| `perform_secondary_action` | 执行界面提供的辅助操作 |
| `set_value` | 设置可编辑元素的值 |
| `select_text` | 选中文字或放置光标 |
| `scroll` | 对指定元素滚动 |
| `drag` | 按截图坐标拖动 |
| `press_key` | 发送按键或组合键 |
| `type_text` | 输入原样文字 |

操作前先调用 `get_app_state`，保持相同 `app` 标识，使用最新索引。操作返回新界面树，需要新截图时再读取状态。[完整参数](docs/USAGE.md#十个工具的参数)与[工作原理](docs/ARCHITECTURE.md)说明了内部 `js` / `js_reset` 到十工具的映射。

## 验证边界

[验证记录](docs/VERIFICATION.md) 记录 0.5 的 41/41 项测试、29 模块检查、真实 magpie 十工具检测和原生只读发现。本轮未控制目标应用；0.4 的 GUI 截图及测试数量仅作历史记录。历史滚动方向限制、全部 Agent 和模型兼容性没有普遍通过的结论。

本机 Codex 配置仅同步运行参数白名单和 browser 服务定义，当前继承环境优先，不复制配置中的其他会话身份或 host pipe。浏览器组件检测成功不等于已有会话：本轮只读浏览器初始化返回 0 个浏览器，未验证接管其他聊天连接或浏览器操作。

## 更新与移除

更新扩展或 Codex 后重新检测并重连 MCP。0.4 的本插件条目可保留原 Agent 选择；遗留 `--config` 仅兼容旧命令格式，其文件不再读取，旧选项不再生效。

移除前先取消资源库分发、移除该 MCP 并关闭连接，再在“扩展”移除插件。没有自动卸载钩子；删除插件不会撤销 Codex 持久批准或系统权限，应由用户在原生界面管理。

## 文档、发布与来源

[使用指南](docs/USAGE.md) · [工作原理](docs/ARCHITECTURE.md) · [故障排查](docs/TROUBLESHOOTING.md) · [贡献指南](CONTRIBUTING.md) · [变更记录](CHANGELOG.md)

后续 GitHub 发布可设置 `magpie-plugin` topic 参与发现；官方精选需另向 [magpie-community/plugins](https://github.com/magpie-community/plugins) 提交收录，当前不宣称已上架。

项目采用 [MIT](LICENSE)。必要 macOS 网关与共享客户端基于 LCU 0.11.4（commit `bf45b8edf01bc380def2ba8355b60a4ab5e1857d`）适配，保留[第三方声明](THIRD_PARTY_NOTICES.md)、[网关来源](src/gateway/SOURCES.md)及[客户端修改记录](vendor/lcu-client/PATCHES.md)。OpenAI 原始组件不随插件分发。
