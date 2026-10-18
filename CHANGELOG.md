# 变更记录

## 0.4.0（未发布）

- 产品入口统一为 magpie“扩展”：添加并加载插件后，自动把 `magpie-computer-use` 登记到“资源库 → MCP 服务器”，由用户选择 Agent 分发。
- 默认提供 `list_apps`、`get_app_state`、`click`、`perform_secondary_action`、`set_value`、`select_text`、`scroll`、`drag`、`press_key`、`type_text` 十个工具。原始 `js` / `js_reset` 保留为内部脚本接口。
- 包内包含设置页、必要 macOS 网关及共享客户端，直接使用完整官方 ChatGPT 安装，无需外部 LCU，不复制或修改 OpenAI 二进制。
- 保留应用/helper 身份与签名校验、原始授权、图片、错误、进度和上下文清理；无 elicitation 时取消授权，阻止控制 magpie 与已识别的 Agent 宿主。
- 修复原始 REPL 跨 cell 重复声明共享 Map 导致应用目标丢失的问题，改为按 session/turn/app 保存独立绑定，并增加原始声明重置行为的回归覆盖。
- 记录真实 magpie 扩展流程和 Claude Code 十工具 GUI 验收；保留滚动方向语义限制及未测范围，不将无工具错误等同于全部行为符合预期。
- 整理扩展安装、资源库分发、完整工具参数、工作原理、故障排查、停用/移除和开发验证文档。
- 保留 LCU MIT 来源及修改记录。GitHub 发布、topic 发现和官方精选申请分别记录，当前不宣称已上架。

详细测试结果与当前限制见 [验证记录](docs/VERIFICATION.md)。
