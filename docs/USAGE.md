# 使用指南

适用于 **0.5.0**。通过 magpie“扩展”安装，插件自动识别本机 Codex，没有独立设置页，也不读取旧版选项快照。

## 安装和分发

1. 确认是 Apple Silicon macOS，并已有包含 Computer Use 运行时的完整官方 Codex 桌面应用。
2. 在 magpie“扩展 → 插件”中添加 `github:wbb6517/magpie-computer-use` 并启用；npm 发布后也可按包名 `magpie-computer-use` 添加。本地目录仅用于开发加载。
3. 打开 **资源库 → MCP 服务器 → magpie-computer-use**，选择目标 Agent。
4. 检测十个工具，重连 Agent 或新开会话。先执行 `list_apps`，再对目标执行 `get_app_state`。

自动登记不会替用户启用全部 Agent。Claude Code 等 Agent 均由资源库分发，无需另行手工添加同名 MCP。npm 发布与官方推荐收录是不同状态，推荐列表需另行申请。

Codex 移动或升级后，重连 MCP 会重新发现安装。多个完整安装同时运行且无法根据继承来源确定时，会提示歧义；保留需要使用的一份后重连。默认发现支持 `Codex.app`、`ChatGPT.app`，也支持运行中或 Spotlight 可发现的重命名完整应用。无需修改插件路径设置。

## 沿用 Codex 批准

当前原始运行时与 Codex 桌面端 **Always-allowed apps** 使用同一账户的持久应用批准。若应用已获此类批准，由原始运行时识别并继续访问；插件不维护第二份批准列表，也不自行读取或修改原生批准文件。

如果应用没有持久批准，原始运行时仍可能通过 MCP elicitation 询问用户。使用能显示询问并等待用户回答的 Agent 会话；缺少这项能力时新的批准会取消。其他会话中的临时允许不能自动转借给当前会话。

辅助功能、屏幕录制等 macOS 权限及原生进程认证仍按官方流程处理。不要把登录成功、会话 ID 或应用列表返回当成目标应用已批准。magpie 和 Agent 宿主继续受宿主保护约束。

第一次操作建议使用独立空白测试窗口，先确认界面树与截图，再进行输入。结束后由用户关闭测试文稿并选择不保存。

## 0.4 升级说明

0.5 不再提供应用路径、Chrome 或超时设置界面。旧 magpie 插件选项不再参与运行；原 `options.json` 快照不再读取或写入。

新资源库入口只启动本包 `mcp`。已存在、精确匹配本插件的旧 `mcp --config <旧私有快照>` 格式会兼容保留，`--config` 只解析语法、不打开文件，不覆盖已有 Agent 选择。同名无关条目不会被静默替换。

更新后重新加载扩展，检测资源库条目并重连；不要为了“更新设置”编辑旧 JSON。若本地插件目录移动或条目来源不同，按错误提示在资源库核对来源。

## 工具使用约定

默认提供十个独立操作；内部原始 `js` / `js_reset` 是脚本传输接口，不代表只能执行两种操作。若 Agent 仅显示两个工具，先核对是否使用旧条目或开发接口，再检测并重连。

原始浏览器组件存在时按组件可用性启用对应服务，不设 Chrome 开关。桌面十工具不因此变成浏览器脚本工具；扩展/native host、网站授权与模型能力仍受原始支持限制。

请求预算和空闲清理是本 MCP 的内部连接管理，不承诺每项行为与 Codex 桌面会话完全一致。断开、取消或空闲结束后需重新读取目标状态。

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

0.4.0 历史验收的已知限制：自有 AppKit 测试中，`up` 使滚动条值增大、`down` 使其减小，与按文档内容位置理解的直觉方向相反。调用确实移动内容，但根因未查明，不能假定由系统“自然滚动”设置造成。首次使用应小幅滚动并重新读取界面，再决定下一步；不要盲目重放方向。完整观测见 [验证记录](VERIFICATION.md#已知限制滚动方向)。

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

## 停用与移除

在 magpie“扩展 → 插件”移除本插件后，加载时启动的轻量监视进程会确认安装列表中已移除本插件，再调用 magpie 自带的资源库接口删除对应 MCP、同步撤销 Agent 与项目中的分发。成功后监视进程退出，并删除自己的临时 socket。无需另行运行清理命令。

普通宿主退出、重新加载、版本更新和单纯停用开关不算卸载；停用扩展本身不撤销已分发的独立 MCP，需要暂停工具时在资源库取消分发。自动清理只接受仍指向本包的精确命令，不删除用户替换的同名服务器。宽限内重新安装会取消清理；若实际删除已开始，此时重新安装则恢复默认未分发入口，按新安装重新选择 Agent。安装记录缺失、无效或暂时无法读取时保留配置，等待可确认的状态。若个别 Agent 或项目配置无法写入，保留 magpie 的持有账本并自动重试，直到账本确认撤销成功。

监视进程不安装系统服务，也不运行 Computer Use。它与插件宿主分离，因此正常卸载时，即使包源码已被移除，也能完成清理。若系统重启后始终没有加载过插件就从 CLI 移除，或监视进程被强制终止，则无法保证自动执行；此时在“资源库 → MCP 服务器”手动移除 `magpie-computer-use`。已经建立的 Agent MCP 连接按客户端的断开/重连流程结束。

卸载不会撤销 Codex 的持久应用批准或 macOS 权限；需要撤销时在对应官方界面管理，不编辑批准文件。

新版验证与 0.4 历史 GUI 结果分别见 [验证记录](VERIFICATION.md)。开发检查集中在 [贡献指南](../CONTRIBUTING.md)，故障见 [故障排查](TROUBLESHOOTING.md)。
