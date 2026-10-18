# 贡献指南

0.5 面向无设置页的 magpie 扩展：自动登记资源库 MCP，每次 MCP 启动发现本机 Codex，并由原始组件处理应用批准与原生连接。普通用户不安装 Node 或手写 MCP。

## 开发检查

开发使用 Node.js 24+，在源码根目录执行：

```sh
npm ci --ignore-scripts
npm test
npm run check
```

隔离测试检查发现顺序、歧义处理、旧资源兼容、十工具映射、原始 REPL 绑定、上下文、图片和授权转发及清理。`check` 核对语法、生命周期和无设置页 manifest。旧版 31 项测试与 8 项设置页检查仅属 0.4 历史，不能作为 0.5 当前检查数量。

简单文档和注释修改无需额外编写测试；协议、授权或生命周期变化应运行相关现有检查，必要时增加能识别实际回归的用例。

## 内部运行时验收

Apple Silicon macOS 上有完整官方桌面应用时执行：

```sh
npm run verify-runtime
npm run doctor
npm run smoke:runtime
```

`prepare` 校验完整组件和签名；`doctor` 与 smoke 进行真实只读发现，不代替 GUI 验收。`mcp` 是资源库调用的内部入口，`status`、`doctor`、`prepare` 用于诊断；`--app` 只作开发诊断临时覆盖，不应恢复成产品设置。

验证时覆盖：继承来源、运行中唯一安装、歧义、标准路径、重命名/Spotlight、缺失/无效安装；资源库新条目没有 `--config`，旧精确格式可兼容但不读写旧文件，也不改已有 Agent 选择。测试加载不应启动 GUI 或产生应用询问。

## 原生批准与连接边界

原始 `node_repl` 当前使用 `ComputerUseElicitationInterceptor` 与 `macos_approvals` 读写账户持久批准，沿用桌面 Always-allowed apps。插件不解析批准文件作自动决定，不自行生成 `accept`，不读 `auth.json`、钥匙串或登录 token。

新的目标访问仍应由原始 elicitation 交给用户。不得模拟用户批准、跨会话转借临时授权、扫描其他 session pipe、关闭原始沙箱或绕过身份/签名。正常宿主传入的原生连接环境可保留，不能把它扩展成会话探测。

测试批准复用须区分原始持久批准命中、真实用户新回答与测试 harness 的回答复用。若测试复用用户选择，明确限定对象和方式，不声称零自动回答，也不将测试机制带入生产。

## GUI 与证据分层

```sh
npm run fixture:gui
```

需 Xcode Command Line Tools。使用自有 AppKit 测试窗口，由用户明确允许目标，避免真实业务内容。分别记录工具错误、界面/事件变化、截图返回与模型理解，不用无工具错误替代行为观察。

记录项目、Agent、官方应用/运行时版本及检查时间；不可靠的版本标签应明确缺失。Chrome、不同模型与系统权限状态分别验收。取消和关闭后清理临时窗口、服务与产物，仓库只保留脱敏摘要和合成内容截图。

[验证记录](docs/VERIFICATION.md) 中 0.4 历史、历史 JSON 和 `gui-test.jpg` 应继续标注旧版本。新版不能直接改旧 JSON 的版本号或把旧设置页快照检查当成自动发现已通过。

## 发布和提交

当前尚未发布或进入官方精选。先验收 magpie 扩展加载、自动登记、Agent 选择、Codex 发现、原生批准与卸载边界。后续 GitHub 发布可设置 `magpie-plugin` topic；精选需另外向 [magpie-community/plugins](https://github.com/magpie-community/plugins) 申请收录。未经授权不上传或发布。

```sh
npm test
npm run check
npm pack --dry-run --ignore-scripts
git diff --check
git status --short
```

保留 ESM、中文意图注释、来源和 MIT 许可证。stdout 是 MCP 协议，诊断写 stderr。排除个人路径、密钥、原始批准/登录文件、私人清单、原始日志、官方二进制和开发依赖。PR 明确变更后的行为、检查结果及未验证范围。
