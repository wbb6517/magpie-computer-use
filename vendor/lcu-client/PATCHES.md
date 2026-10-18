# LCU shared-client source

Source: https://github.com/amontlabs/lcu
Version: v0.11.4
Commit: bf45b8edf01bc380def2ba8355b60a4ab5e1857d
Copyright (c) 2026 Amont Labs
License: MIT, see LICENSE.

`client.mjs` is derived from upstream `adapters/client.mjs` and reduced to the transport and lifecycle path used by this package:

- Forward the optional `onprogress` callback from `createCuaClient().call()` to the original MCP SDK request options.
- Remove unused standalone-adapter helpers, native-app choice conversion and host-mod approval brokerage.
- Remove the unexposed host-control status/Stop API, its private socket setup and associated cleanup.
- Remove diagnostic-file logging, call/approval statistics and stderr classification. The `diagnostics.mjs` implementation is not included. Piped upstream stderr is still drained continuously and a bounded tail is retained for startup failures.
- Remove the diagnostic-only worker hook status accessor. Keep worker generations, upstream turn IDs and cleanup before resetting the worker.

`host-guard.mjs` retains the upstream agent-host approval guard. Original MCP instructions, tools, results, images, errors, progress, native authorization relay, approval-aware deadlines and turn cleanup remain on the active path. No OpenAI binaries are included or modified.

本次注释维护：将共享客户端与宿主授权守卫的关键注释转换为简体中文，补充真实会话身份、授权等待、stderr 排空与 worker 重置前清理的说明；所有可执行语句、错误信息与上游版权归属保持不变。
