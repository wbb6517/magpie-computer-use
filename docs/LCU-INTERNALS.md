# LCU 的实现链路

实现基于 LCU **v0.11.4**、commit `bf45b8edf01bc380def2ba8355b60a4ab5e1857d` 分析。重点是 Apple Silicon macOS。源码来自本机已校验的该版本发布包，并对照仓库适配文档。

LCU 是原始 Computer Use 运行时的启动器、宿主与 Agent 适配层。截图、辅助功能、输入和 JavaScript 执行仍属于本机官方应用的原始实现。

## 一次操作如何流动

```text
Agent 的工具调用
  → MCP 适配器（保存原始说明和工具定义）
  → 官方 cua-repl MCP 入口
  → node_repl 的 JS kernel + trusted worker
  → 原始 @oai/sky service
  → 官方签名的 macOS Computer Use helper
  → 用户授权的目标应用
```

1. `lcu/runtime.mjs` 定位官方应用，校验架构、应用身份及所需组件，配置 `CUA_REPL_NODE_REPL_PATH`、`NODE_REPL_NODE_PATH`、模块目录和可信服务目录。
2. 启动本机 `cua_node/bin/node`，执行原始 `@oai/cua-repl/bin/cua-repl.mjs`。不是单独运行 `SkyComputerUseClient mcp`。
3. `node_repl` 启动 JavaScript kernel 和 trusted worker。模型的 `cua.getApp`、截图、点击调用通过原始服务走到签名 helper。
4. `adapters/client.mjs` 使用官方 MCP SDK，把初始化说明、`js`/`js_reset` 的定义及结果交给 Agent。图片保留为 MCP image block，`isError` 保持原值。

源码：[runtime.mjs](https://github.com/amontlabs/lcu/blob/v0.11.4/lcu/runtime.mjs)、[client.mjs](https://github.com/amontlabs/lcu/blob/v0.11.4/adapters/client.mjs)。

## 认证、身份、应用授权是三个环节

- **进程认证**：原始 Sky/native transport 与签名 helper 之间执行。LCU 从完整官方安装中启动整套原始链路；未发现可供用户填写的“认证 token”配置，也没有证据说明 `session_id` 可以替代认证。原生内部校验细节属于 OpenAI 组件，不能从 LCU JavaScript 推断完整协议。
- **上下文身份**：适配器在 MCP `_meta['x-codex-turn-metadata']` 放入宿主的 `session_id`、`turn_id`，用于归属与清理。缺少宿主事件时只能用真实连接身份，不能伪称真实聊天回合。
- **应用授权**：原始运行时发 MCP elicitation。适配器显示原始请求并返回人的选择；客户端不能提问时取消。授权与是否登录 Codex 是不同环节。

所以先前 `Sender process is not authenticated` 指向本机进程/连接层。单凭这句错误不能断言缺少哪一个参数，更不能把会话 ID 当作密码或以自动批准修复。

源码：[适配契约](https://github.com/amontlabs/lcu/blob/v0.11.4/docs/ADAPTERS.md#shared-client-contract)、[host-guard.mjs](https://github.com/amontlabs/lcu/blob/v0.11.4/adapters/host-guard.mjs)。

## 结束时为何还需要一个宿主

`lcu/macos_sky_service.mjs` 在原始 Sky RPC 接口上加生命周期包装，注册 `nodeRepl.addTurnEndedHandler`。宿主报告 Stop/Interrupt 时，通知原始服务结束对应 session/turn，并通过私有 socket 调用原始 `SkyComputerUseClient turn-ended` 做原生清理。

`lcu/macos_host.mjs` 与该 MCP 进程同寿命，维护上下文，进程断开时补做清理。它还包含严格校验的旧服务恢复逻辑：仅在证明原服务确实过期且属于本账户、持有对应 socket 时尝试恢复；不会按名字随便结束正常服务。

`js_reset` 前也要处理旧 worker 持有的回合，否则 worker 销毁后可能丢失原生事件清理。共享 client 通过 worker generation 管理重置后的身份与清理。

源码：[macos_sky_service.mjs](https://github.com/amontlabs/lcu/blob/v0.11.4/lcu/macos_sky_service.mjs)、[macos_host.mjs](https://github.com/amontlabs/lcu/blob/v0.11.4/lcu/macos_host.mjs)。

## 收进 magpie 插件的部分

插件内置必要的 macOS 网关源码与 MCP 客户端，在本包中直接启动原始运行时。默认 MCP 将十个独立操作映射到原始 cua-repl API；显式 JavaScript 接口保留 js/js_reset。去掉外部 LCU 二进制、发布包下载、独立安装、setup/update 和各 Agent 的专用安装流程；各 Agent 的配置写入统一交给 magpie 资源库。

保留官方签名验证、原始运行时、用户授权转发、图片/错误/进度和上下文清理。MIT 来源代码继续标明 LCU 版本、文件和许可证；OpenAI 二进制没有复制进插件。

统一 MCP 入口兼容协议，不意味着能凭空补出客户端缺失的图片显示、elicitation 或聊天回合事件。具体实测范围见 VERIFICATION.md。
