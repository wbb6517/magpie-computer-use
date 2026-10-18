# magpie Computer Use

面向 magpie 的 Computer Use 扩展。添加扩展后，插件自动把 `magpie-computer-use` 登记到 **资源库 → MCP 服务器**，由用户选择要分发的 Agent，默认提供十个 macOS 操作工具。

原生能力来自本机官方 ChatGPT 应用中的完整运行时。插件内置必要网关，无需额外安装 LCU，不下载、复制或修改 OpenAI 二进制。

## 当前状态

当前版本 **0.4.0 尚未发布，尚未进入 magpie 官方精选**。本机可从 magpie 的“扩展”添加项目本地目录进行体验，无需运行安装命令。

后续 GitHub 发布可通过仓库的 `magpie-plugin` topic 参与发现；进入官方精选还需向 [magpie-community/plugins](https://github.com/magpie-community/plugins) 提交收录，不能把 GitHub 发布等同于官方上架。

## 环境要求

- 已安装 magpie。
- Apple Silicon Mac（`darwin-arm64`）；当前不支持 Intel Mac、Windows 或 Linux。
- 完整、签名有效的官方 `ChatGPT.app`，默认位于 `/Applications/ChatGPT.app`，并包含 `cua_node`、`@oai/cua-repl`、Computer Use helper 等组件。同名应用或不带这些组件的安装不能使用。
- 目标 Agent 支持 magpie 分发的 stdio MCP。图片显示、应用授权询问（elicitation）和回合事件依赖该 Agent 的能力，具体实测范围见验证记录。
- 控制目标应用时，由用户完成原始应用授权及 macOS 所需的辅助功能、屏幕录制等权限流程。

开发与脚本检查需要 Node.js 24+，见 [贡献指南](CONTRIBUTING.md)。官方应用升级后应重新检测 MCP；插件按当前运行时内部布局接入，不保证所有版本都兼容。

## 添加与使用

1. 在 magpie 中打开 **扩展**，添加本项目的本地目录，并启用该扩展。
2. 打开扩展的 **Computer Use** 设置页。确认完整官方 ChatGPT 应用路径；修改后保存并重新加载扩展。
3. 进入 **资源库 → MCP 服务器**，找到自动登记的 `magpie-computer-use`。
4. 在该条目选择要使用的 Agent，或点击“全部”。重新检测工具，确认默认列出十个操作工具。
5. 重连所选 Agent 的 MCP，或新开会话。先让 Agent 只执行 `list_apps`，再对专门的测试应用调用 `get_app_state`，由用户回答授权。

扩展加载与 Agent 分发是两个步骤：自动登记条目不等于替用户启用全部 Agent。Claude Code 等 Agent 也通过此资源库条目接入。完整操作说明见 [使用指南](docs/USAGE.md)。

本地目录是扩展代码来源，使用期间应保留在原位置；移动目录后须在“扩展”中更新来源，再检查资源库条目并重连。

## 十个操作工具

| 工具 | 用途 |
| --- | --- |
| `list_apps` | 发现正在运行或近期使用的应用 |
| `get_app_state` | 选择应用、请求原始授权，获取界面树和截图 |
| `click` | 根据最新元素索引或截图坐标点击 |
| `perform_secondary_action` | 执行界面树明确提供的辅助操作 |
| `set_value` | 设置可编辑元素的值 |
| `select_text` | 选中文字或将光标放在文字前后 |
| `scroll` | 对指定元素按方向滚动 |
| `drag` | 按截图坐标拖动 |
| `press_key` | 发送按键或组合键 |
| `type_text` | 输入原样文字 |

先调用 `list_apps`，再调用 `get_app_state`。后续操作保持相同 `app` 标识，并使用最新界面中的索引或坐标。操作后返回更新的界面树；需要新截图时再次调用 `get_app_state`。所有参数见 [使用指南](docs/USAGE.md#十个工具的参数)。

内部原始运行时只有 `js` / `js_reset` 两个脚本工具，插件把具体操作封装为上述十个工具。两者不是按操作能力计数的同一接口，详见 [工作原理](docs/ARCHITECTURE.md#为什么内部是两个工具对外是十个)。

## 设置与授权

| 设置 | 默认值 | 范围或含义 |
| --- | --- | --- |
| ChatGPT 应用路径 | `/Applications/ChatGPT.app` | 完整官方应用的绝对路径 |
| Chrome 集成 | 关闭 | 启用内部原始浏览器服务；不会安装扩展或增加桌面工具 |
| 单次请求 | 120 秒 | 30–600 秒；等待用户授权时暂停计时 |
| 连接空闲 | 5 分钟 | 1–30 分钟；达到上限后清理并断开 |

设置页保存选项后，magpie 重新加载插件并更新私有选项快照；资源库连接使用此快照。设置页不证明 MCP 或桌面操作已就绪，正在使用的 MCP 仍需重连。

应用授权经原始 MCP elicitation 交给用户回答。客户端不支持授权询问时取消该次授权。magpie 和已识别的 Agent 宿主被拒绝控制，避免 Agent 操作自己的批准界面。

每个 MCP 连接拥有独立上下文；原始图片、错误和进度按 MCP 转发。中断、超时、断开和空闲触发相应清理。进程认证、会话身份、目标应用授权与 macOS 权限属于不同环节，不能相互替代。

## 测试与限制

已通过真实 magpie 0.1.1272 扩展界面完成自动登记、十工具检测和设置快照更新；Claude Code 2.1.301 结合官方 Agent SDK 在自有 AppKit 测试应用执行了十个工具。`scroll` 确实移动内容，但方向表现与内容导航直觉相反，根因未查明。

环境、授权测试方式、逐项结果和限制见 [验证记录](docs/VERIFICATION.md)、[Claude Code GUI 摘要](docs/claude-code-verification.json) 与 [只读 smoke 记录](docs/verification.json)。本轮不代表 Chrome、所有 Agent、模型或控件均兼容；资源库显示十个工具也不等于已获目标应用授权。

开发检查和内部 MCP 验收步骤集中在 [贡献指南](CONTRIBUTING.md)。

## 停用与移除

先在资源库取消该条目的 Agent 分发并移除该 MCP 条目，关闭正在使用的连接；再到“扩展”停用或移除本插件。当前没有自动卸载钩子，移除扩展不会替用户清理资源库条目。

移除扩展不会自动撤销 macOS 或原始应用中已授予的权限，这些权限由用户在相应界面管理。不要直接删除正在被连接使用的本地插件目录。

## 文档与来源

- [使用指南与完整参数](docs/USAGE.md)
- [工作原理、目录和生命周期](docs/ARCHITECTURE.md)
- [故障排查](docs/TROUBLESHOOTING.md)
- [LCU 源码分析](docs/LCU-INTERNALS.md)
- [贡献与验证要求](CONTRIBUTING.md)
- [变更记录](CHANGELOG.md)

本项目采用 [MIT 许可证](LICENSE)。内置 macOS 网关和共享客户端基于 Amont Labs 的 LCU **0.11.4**（commit `bf45b8edf01bc380def2ba8355b60a4ab5e1857d`）适配，保留来源与许可证。详见 [第三方声明](THIRD_PARTY_NOTICES.md)、[网关来源](src/gateway/SOURCES.md) 和 [客户端修改记录](vendor/lcu-client/PATCHES.md)。OpenAI 二进制不随插件分发，其使用继续受原始条款与权限约束。
