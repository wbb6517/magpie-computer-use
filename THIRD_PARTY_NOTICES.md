# Third-party components

## Included LCU gateway source

- Repository: https://github.com/amontlabs/lcu
- Source version: 0.11.4
- Commit: bf45b8edf01bc380def2ba8355b60a4ab5e1857d
- License: MIT; Copyright (c) 2026 Amont Labs. See [gateway license](src/gateway/LICENSE) and [client license](vendor/lcu-client/LICENSE).
- `src/gateway` contains the required macOS host/service/launch code adapted into this package. Its source and modifications are recorded with those files.
- `vendor/lcu-client` contains the MCP shared client and host guard; see its LICENSE and PATCHES.md.
- LCU attribution identifies source provenance. The plugin does not download or execute an external LCU release, require an LCU install, or read `.runtime/lcu`.

## Model Context Protocol SDK

`@modelcontextprotocol/sdk` 1.30.0, MIT, installed through the package lock. It provides the MCP transports and elicitation protocol.

## Original Computer Use runtime

OpenAI binaries and instructions are not redistributed. They are read in place from the user's existing, signed ChatGPT installation. The plugin does not modify or re-sign them, copy authentication secrets, or grant macOS/app access. Original terms and permissions remain applicable.

## TOML parser

`smol-toml` 1.9.1, BSD-3-Clause, installed through the package lock. It parses the local Codex configuration; only the documented runtime environment allowlist is reused. See its packaged LICENSE.
