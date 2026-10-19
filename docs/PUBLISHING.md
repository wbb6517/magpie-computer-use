# npm 发布与 magpie 发现

本包按 [magpie 官方发布规范](https://usemagpie.ai/docs/zh/plugins#publish) 发布到 npm，包名为 `magpie-computer-use`。插件通过 magpie 扩展界面添加，加载后自动登记资源库 MCP。

## 包的约定

- ESM 入口为 `index.mjs`，`exports["./server"]`、`main`、`exports["."]` 指向同一入口。默认导出 `{ id, server }`，辅助测试函数放在 `_internal` 对象内。
- 关键词包含 `opencode`、`opencode-plugin`，满足 magpie npm 搜索的过滤条件。此包的使用入口仍是 magpie。
- `repository` 指向公开的 `wbb6517/magpie-computer-use` 仓库；README、源码、许可证和文档随包分发。
- `magpie.icon` 内嵌 SVG data URI，与 `assets/icon.svg` 保持一致；图标不依赖外网图片地址，README 封面和资源一同打包。
- 仅支持 Apple Silicon macOS；运行依赖通过 npm 安装，无需安装脚本或构建步骤，不分发官方 OpenAI 二进制、用户配置或登录信息。
- 这是工具扩展，不提供模型、供应商登录或单独设置页。应用访问沿用本机 Codex 与 macOS 的原生授权。

## 维护者发布

从已核对的源码目录运行现有测试和检查，再生成 tarball。发布已经验收的同一份 tarball，避免上传目录中的后续改动：

```sh
npm test
npm run check
npm pack --ignore-scripts
npm publish ./magpie-computer-use-0.5.0.tgz --access public --registry=https://registry.npmjs.org/
```

示例版本号应随发布版本更新。保持 `package.json`、锁文件和 MCP 版本一致。登录或二次验证由维护者在 npm 官方流程中完成，不把 token、验证码或 `.npmrc` 放入仓库或包内。发布后查询远端版本、仓库、关键词及 tarball integrity，并从注册表安装进行验收。包名和版本组合发布后不能再次覆盖。

## 用户添加

npm 发布前可从 magpie“扩展 → 插件”添加 `github:wbb6517/magpie-computer-use`；发布后也可按包名 `magpie-computer-use` 添加，启用后到“资源库 → MCP 服务器”选择 Agent。无需克隆仓库、运行插件安装命令或手工编辑 MCP。

## 搜索与推荐列表

npm 搜索索引可能晚于包发布更新。GitHub 发现使用 `magpie-plugin` topic；仓库中的 `repository` 让 magpie 将已发布包关联到 npm 安装来源。

官方推荐列表单独通过 `magpie-community/plugins` 的 `registry.json` 收录，本包使用中间件类型 `kind: "middleware"`，不声明虚构的模型供应商。npm 发布不等于推荐收录；申请推荐 PR 和修改 GitHub topic 应按维护者的另行安排执行。
