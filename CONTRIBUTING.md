# 贡献指南

项目面向 magpie 扩展产品：用户从“扩展”添加插件，扩展加载后自动登记资源库 MCP，用户在资源库选择 Agent。开发脚本和内部 MCP 命令用于实现检查与验收，不应成为普通用户的安装步骤。

先阅读 [工作原理](docs/ARCHITECTURE.md)，保留原始认证、授权、沙箱和清理边界。

## 本地开发

要求 Node.js 24+。在源码根目录执行：

```sh
npm ci --ignore-scripts
npm test
npm run check
```

普通代码与 fixture 检查不需要官方应用或真实 GUI。运行时验收额外需要 Apple Silicon macOS 和完整官方 ChatGPT 安装。Node.js 24+ 是开发脚本要求，普通用户通过 magpie 的 Bun launcher 启动 MCP，无需自行安装 Node。

- `npm test`：隔离 fixture，检查十工具 schema/映射、参数编码、MCP 转发、上下文、授权、清理、配置及资源库登记行为。
- `npm run check`：项目语法、manifest 入口与资源检查，并运行设置页检查。
- `node scripts/check-page.mjs`：单独检查选项读取/保存、单位转换、主题、错误与页面沙箱行为；不等于真实 magpie UI 验收。

本地界面验收从 magpie“扩展”添加当前源码目录，检查加载后是否自动出现资源库 MCP，再在资源库选择测试 Agent。确认 `server(input, options)` 把快照写入 magpie 配置目录下的 `plugins/magpie-computer-use/options.json`，资源库通过 magpie 管理的 Bun launcher 运行内部 `mcp --config` 入口。保存设置后确认快照更新，重连后生效。不要把手动写入客户端配置的结果代替扩展安装验收。

简单、可逆的文档或注释修改无需为了流程额外添加测试；涉及协议、授权和生命周期时运行现有相关检查，必要时增加能发现实际回归的用例。

## 内部运行时与 MCP 验收

以下脚本只供开发诊断：

```sh
npm run verify-runtime
npm run doctor
npm run smoke:runtime
```

| 层次 | 可证明的内容 | 不能据此宣称 |
| --- | --- | --- |
| fixture / 静态检查 | 参数、协议、转发及生命周期逻辑 | 原生认证或真实 GUI 成功 |
| `verify-runtime` | 完整组件、布局和官方签名兼容 | helper 已执行目标应用操作 |
| `doctor` / 只读 smoke | 真实运行时启动、工具发现、应用列表 | 应用授权、截图和全部工具已通过 |
| magpie 扩展 UI | 添加、自动登记、选 Agent、重连链路 | 所有 Agent 和所有操作都兼容 |
| 用户参与的 GUI 测试 | 指定应用、版本和环境中的实际结果 | 其他环境全部兼容 |

`smoke:runtime` 更新 `docs/verification.json`，只检查工具列表与 `list_apps`，遇到授权请求时取消。原始传输内部是 `js` / `js_reset`；扩展对外默认应为十工具，验收时分别记录，不能混淆。

开发 CLI 只保留内部 `mcp` 服务入口与 `status`、`doctor`、`prepare` 诊断，不提供面向用户的安装、注册、配置导出或卸载命令。内部显式 JavaScript 接口用于原始脚本兼容检查，不应写成另一条产品安装路径；正常资源库条目始终按默认十工具验收。

## GUI 测试窗口与用户授权

本机装有 Xcode Command Line Tools 时可运行：

```sh
npm run fixture:gui
```

脚本把自有 AppKit 测试源码编译到系统临时目录，临时签名并打开测试窗口，不修改官方应用。按终端输出选择这个测试应用路径，用户自己回答原始授权。窗口提供输入框、计数按钮、步进器、滚动文字和滑块，用于分别检查工具。

真实 GUI 测试须使用用户指定或同意的测试窗口。不能自动 `accept`，不能控制 Agent 自己的授权界面，也不能用发送信息、覆盖真实文件等业务操作代替测试。无交互界面的 Agent 调用可能取消 elicitation，应使用能展示原始请求并等待真实用户回答的交互式宿主；未回答必须取消。

逐项记录实际执行的工具、应用、版本、结果及限制；未执行、不支持和失败分别记录。fixture 的图片转发通过与客户端真实显示截图应分开。测试后正常关闭连接与测试窗口，清理临时产物。仓库只保留脱敏摘要，不上传原始截图或完整日志。

更新 [验证记录](docs/VERIFICATION.md) 时同步核对机器记录，注明时间、系统、Agent、项目/官方应用/运行时版本。不要把旧结果或手工内部连接当成当前扩展产品流程已验收。

## 发布与收录

当前版本尚未发布，尚未进入官方精选。发布前需完成：

1. 核对 magpie“扩展”添加、自动登记、私有快照更新、Agent 选择及停用/移除流程。当前没有自动卸载钩子，应先取消资源库分发并移除 MCP，再移除扩展。
2. 检查 GitHub 和 npm 包中没有个人路径、密钥、原始截图/日志或官方二进制。
3. GitHub 发布后设置仓库 topic `magpie-plugin`，参与相应发现机制。
4. 如需进入官方精选，向 [magpie-community/plugins](https://github.com/magpie-community/plugins) 按其要求申请收录。

GitHub 可发现、npm 可安装和官方精选是不同状态；未完成前不使用“已上架”或“官方精选”作为产品事实。

## 修改约定

- 保持 ESM 风格；原始标识符、协议字段和错误文本保留原语言，中文注释解释意图及边界。
- 自动登记应避免重复条目，保护用户已有 Agent 选择，遇到无关同名定义不能静默覆盖。
- 保留来源和 MIT 许可证；来源实现修改同步更新 `src/gateway/SOURCES.md` 或 `vendor/lcu-client/PATCHES.md`。
- 不引入运行时下载器、复制的 OpenAI 二进制、个人绝对路径、自动批准或认证/沙箱旁路。
- stdout 为 MCP 协议；诊断写 stderr，并避免私人内容。
- 用户文档统一围绕“扩展 → 自动登记 → 资源库选 Agent”，内部命令留在开发文档。

## 提交前检查

```sh
npm test
npm run check
npm pack --dry-run --ignore-scripts
git diff --check
git status --short
```

打包清单不代表已发布或真实 GUI 通过。提交范围应包含相关代码、文档和脱敏测试记录；排除 `node_modules`、编辑器私有状态、本地选项、账号/密钥、个人路径、原始截图/录像、完整日志、应用列表、原始运行时文档缓存和官方二进制。

PR 说明具体问题、修改后行为、执行的检查和验证边界。无需为贡献关闭签名检查、降低原始沙箱或授予宿主控制权限。
