# Embedded gateway source provenance

Derived from LCU 0.11.4, commit bf45b8edf01bc380def2ba8355b60a4ab5e1857d, MIT, Copyright (c) 2026 Amont Labs. Full license: LICENSE.

- macos_host.mjs: derived from upstream lcu/macos_host.mjs. Remove the unused TrustedControlBridge status/Stop channel and its controlAddress option. Keep the private lifetime socket, open-turn tracking, bounded turn-ended commands, stale-service recovery and shutdown cleanup. The socket framing/listen/send helpers remain because the lifetime and recovery protocol uses them.
- macos_sky_service.mjs: derived from upstream lcu/macos_sky_service.mjs. Remove unused status/Stop control routing and its context/connection state. Retain the original native client used by turn cleanup, renamed from controlClient to nativeClient. Keep lifetime notifications, native IPC and CLI cleanup/retries, stale-service recovery, turn tracking and the upstream Unicode type_text adaptation.
- app_layout.mjs: original upstream lcu/app_layout.mjs, unchanged except for an attribution header and Chinese comments.
- lock.mjs: only the macOS tryExclusiveOpen/O_EXLOCK subset of upstream lcu/lock.mjs.
- entry.mjs: new package-local launcher adapted from upstream runtime.mjs environment/macOS launch flow and platforms.mjs checks. It takes an explicit official-app path and uses only the macOS backend. All required files and the app/helper identity and deep signatures are checked at each launch. No external installer, release descriptor, update mechanism, CLI adapter, platform shim, signature cache or LCU executable is used. The original signed app is neither copied nor modified.

Internal LCU_MAC_* environment names remain because the included client and host/service source use that private lifetime/recovery protocol. They do not locate or invoke an external LCU installation. The unused LCU_MAC_CONTROL_SOCKET status/Stop protocol is omitted.

Chrome selects the original browser surface only. This package does not include upstream browser install/private native-host relay code; it needs the user's existing official extension/native host and original authorization flow.

本次注释维护：将内置网关与 macOS 宿主的关键英文说明转换为简体中文，补充签名验证、账户身份、轮次清理、超时与恢复边界的原因说明；保留上游版权声明、标识符、日志及所有可执行语句。
