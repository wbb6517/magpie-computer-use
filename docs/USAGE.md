# 使用指南

本文对应 0.4.0，按 magpie 扩展的方式使用。扩展负责自动登记 MCP，用户在 magpie 资源库中选择 Agent。

## 1. 准备环境

需要 magpie、Apple Silicon macOS，以及完整、签名有效的官方 `ChatGPT.app`。默认路径为 `/Applications/ChatGPT.app`，该安装必须包含 `cua_node`、`node_repl`、`@oai/cua-repl`、Computer Use helper 及配套组件。

只有应用显示名称相同并不足以使用；缺少完整运行时、不同架构或签名不符合要求时，MCP 检测会失败。不要选择内部 helper、复制出的 Node、符号链接或重新签名的副本。

当前版本尚未发布，也未进入官方精选。本机体验使用完整项目本地目录；GitHub 发布、社区发现与官方收录是不同状态。

## 2. 从“扩展”添加

1. 打开 magpie 的 **扩展**，添加本项目的本地目录。
2. 启用扩展，打开 **Computer Use** 设置页。
3. 确认 ChatGPT 应用路径。若不在默认位置，填写实际的绝对路径；目录名应为 `ChatGPT.app`。
4. 保存修改。magpie 重新加载插件后更新选项快照，新的 MCP 连接从快照读取配置。

正常使用不需要在终端安装或手动注册 MCP。插件加载后会自动把 `magpie-computer-use` 登记到 **资源库 → MCP 服务器**。

选项快照由插件写入 magpie 配置目录下的 `plugins/magpie-computer-use/options.json`，供本插件 MCP 读取，用户无需手工编辑。设置页保存的是配置，不负责实时连接或桌面验收。如果出现加载或自动登记错误，保留错误原文，按 [故障排查](TROUBLESHOOTING.md) 检查；不要以“已保存”当作“已连接”。

本地添加会引用该目录，使用期间保留其内容和位置。更新或移动目录后，在“扩展”中重新加载或更新来源，再检查资源库条目。

## 3. 在资源库分发给 Agent

1. 进入 **资源库 → MCP 服务器 → magpie-computer-use**。
2. 选择希望使用的 Agent；需要分发给所有可选 Agent 时点击“全部”。
3. 重新检测工具，确认默认列出十个操作工具。
4. 重连目标 Agent 的 MCP，或新开会话，让它加载新的工具列表。

自动登记条目不会替用户选择全部 Agent。可用 Agent 以本机 magpie 资源库为准；协议可分发不等于每个 Agent 的截图显示、授权卡片和回合事件都经过实测。

### 在 Claude Code 中使用

在资源库给该条目选择 Claude Code，由 magpie 分发配置。随后重开 Claude Code 会话，或使用 `/mcp` 查看服务并重新连接。先让 Agent “只列出可用应用，不操作任何应用”，确认可以调用 `list_apps`。

需要访问应用时，使用交互式会话回答原始授权询问。没有交互界面的调用方式可能无法呈现 elicitation，网关会取消该次授权；不能把这种取消当作截图或点击本身已经失败。不要另外手工建立重复的同名 MCP 条目。

Claude Code 2.1.301 已结合官方 TypeScript Agent SDK 0.3.301 在自有测试应用执行十个工具。本轮后续原始授权由测试 harness 限定目标与 schema 后复用用户的同一选择；生产插件不自动批准应用。环境、模型与滚动方向限制见 [验证记录](VERIFICATION.md)。

### 更新后重新检测与重连

扩展更新、修改设置或官方应用升级后：

1. 重新加载扩展。
2. 在资源库重新检测该条目。
3. 重连所选 Agent，或新开会话。
4. 再调用 `list_apps`；控制目标前重新调用 `get_app_state`。

如果资源库中存在同名的无关 MCP，先核对其归属。不要直接覆盖或删除不明配置，详见故障排查。

## 4. 配置选项

| 设置 | 配置字段 | 默认值与范围 |
| --- | --- | --- |
| ChatGPT 应用路径 | `appPath` | `/Applications/ChatGPT.app`，完整官方应用绝对路径 |
| Chrome 集成 | `chrome` | `false`，启用内部原始浏览器服务 |
| 单次请求 | `requestTimeoutMs` | `120000` 毫秒；页面显示秒，范围 30–600 秒 |
| 连接空闲 | `idleTimeoutMs` | `300000` 毫秒；页面显示分钟，范围 1–30 分钟 |

请求活动时间不包含等待用户授权的时间；Agent 本身还可能设置额外超时。达到空闲上限后连接会清理并断开，后续操作需重连并重新选择应用。

Chrome 开关不会安装浏览器扩展或 native host，也不会自动授予网站访问权限。插件默认提供十个 macOS 操作，浏览器脚本接口属于内部高级能力，不能仅因开启此开关就假定已完成浏览器接入。实际范围见 [验证记录](VERIFICATION.md)。

## 5. 第一次访问应用

先准备专门的空白测试窗口，例如 TextEdit 未保存文稿。让 Agent 列出应用，再调用 `get_app_state`；由用户回答目标应用授权及 macOS 提示。确认界面树和截图后，再尝试输入等操作。

应用授权不替代辅助功能或屏幕录制权限，进程认证也不是填写会话 ID 或 token。magpie、已知 Agent 宿主及承载当前 Agent 的应用不能作为控制目标。

完成测试后，由用户关闭测试文稿并选择不保存。真实业务窗口的发送、删除、支付、保存等操作应遵循当前任务中用户的明确授权。

## 十个工具的参数

以下 JSON 是各工具的 `arguments`，不是 shell 命令。所有工具拒绝未声明的字段。元素索引采用**数字字符串**，如 `"12"`。坐标是最近截图上的像素坐标。

先选用专门的空白测试窗口，例如 TextEdit 未保存文稿。先读取界面，再把示例索引和坐标替换成最新返回值；不要直接重放示例到真实业务窗口。结束后由用户关闭文稿并选择不保存。除 `list_apps` 外，目标操作都需要在**同一上下文**先以相同 `app` 值调用 `get_app_state`。

### `list_apps`

无参数；只做应用发现，不授权或控制目标。

```json
{}
```

### `get_app_state`

必填 `app`：应用名称、绝对 `.app` 路径或 bundle identifier。该调用沿原始流程请求授权，返回界面树与截图。

```json
{ "app": "com.apple.TextEdit" }
```

### `click`

必填 `app`，并提供 `element_index` **或** `x`、`y`，两种方式不能混用。可选 `click_count` 为正整数，默认 `1`；`mouse_button` 为 `left`、`right`、`middle`，默认 `left`。

```json
{ "app": "com.apple.TextEdit", "element_index": "12", "click_count": 1, "mouse_button": "left" }
```

坐标方式示例：

```json
{ "app": "com.apple.TextEdit", "x": 400, "y": 300 }
```

### `perform_secondary_action`

必填 `app`、`element_index`、`action`。`action` 必须来自最新界面树明确列出的辅助操作；不能猜测应用未提供的操作名。

```json
{ "app": "com.apple.TextEdit", "element_index": "12", "action": "从最新界面树复制的辅助操作名" }
```

### `set_value`

必填 `app`、`element_index`、字符串 `value`。用于可编辑元素，空字符串可用于清空测试字段。

```json
{ "app": "com.apple.TextEdit", "element_index": "12", "value": "Computer Use 测试文本" }
```

### `select_text`

必填 `app`、`element_index`、字符串 `text`。可选 `prefix`、`suffix` 用于消歧；`selection` 为 `text`（默认）、`cursor_before` 或 `cursor_after`。

```json
{ "app": "com.apple.TextEdit", "element_index": "12", "text": "测试", "prefix": "Computer Use ", "suffix": "文本", "selection": "text" }
```

### `scroll`

必填 `app`、`element_index`、`direction`。方向为 `up`、`down`、`left`、`right`。可选 `pages` 为大于 `0` 的数值，默认 `1`。

```json
{ "app": "com.apple.TextEdit", "element_index": "12", "direction": "down", "pages": 1 }
```

已知限制：自有 AppKit 测试中，`up` 使滚动条值增大、`down` 使其减小，与按文档内容位置理解的直觉方向相反。调用确实移动内容，但根因未查明，不能假定由系统“自然滚动”设置造成。首次使用应小幅滚动并重新读取界面，再决定下一步；不要盲目重放方向。完整观测见 [验证记录](VERIFICATION.md#已知限制滚动方向)。

### `drag`

必填 `app`、数值 `from_x`、`from_y`、`to_x`、`to_y`。请先在测试文稿内确认拖动起止位置。

```json
{ "app": "com.apple.TextEdit", "from_x": 300, "from_y": 250, "to_x": 450, "to_y": 250 }
```

### `press_key`

必填 `app`、非空字符串 `key`，如 `Return`、`Tab`、`super+a`。

```json
{ "app": "com.apple.TextEdit", "key": "Tab" }
```

### `type_text`

必填 `app`、字符串 `text`。向当前焦点输入原样文本；它不替代 `set_value` 的元素定位。仅在确认焦点位于空白测试文稿后执行。

```json
{ "app": "com.apple.TextEdit", "text": "Computer Use 本地测试\n" }
```

点击等操作返回更新的界面树。需要核对图片时再次调用 `get_app_state`，不要假定每个操作结果都带新截图。界面变化后应使用新索引；连接重建或上下文结束后须重新选择应用。

## 为什么有时看到两个工具

扩展默认对 Agent 提供十个操作工具。内部原始运行时使用 `js` / `js_reset`，十个操作都经固定的原始 API 调用执行；原始两个工具不是“只支持两种操作”。

如果资源库或 Agent 仍只显示 `js` / `js_reset`，可能连接了旧条目或开发用 JavaScript 接口。核对条目来源，重新加载扩展、检测工具并重连。正常安装流程不需要手工切换或额外配置脚本接口。

## 停用与移除

1. 在资源库取消 `magpie-computer-use` 的 Agent 分发，移除该 MCP 条目，并关闭正在使用的连接。
2. 在 magpie 的“扩展”中停用或移除本插件。
3. 确认连接已停止后，再处理本地插件目录。

当前没有自动卸载钩子，删除扩展不会自动移除资源库中的 MCP。

卸载不会撤销系统或原始应用中已经授予的权限。需要撤销时，由用户在对应的 macOS 和应用界面操作。开发者的源码准备与内部验收见 [贡献指南](../CONTRIBUTING.md)。
