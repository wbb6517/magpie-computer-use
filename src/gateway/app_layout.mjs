// 基于 amontlabs/lcu v0.11.4，提交 bf45b8edf01bc380def2ba8355b60a4ab5e1857d。
// Copyright (c) 2026 Amont Labs. MIT license; see LICENSE in this directory.
// 在受支持的官方应用目录布局中定位原始 Codex CLI 文件。
// 同时用于 magpie 的可信 Bun launcher 预检和原始 Node 网关。
import { lstatSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

function regularFile(root, path) {
  try {
    if (!lstatSync(path).isFile()) return false;
    let current = root;
    for (const component of relative(root, path).split(sep).slice(0, -1)) {
      current = join(current, component);
      if (!lstatSync(current).isDirectory()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** 从同一种已知资源布局返回完整的原始 CLI/宿主配对 `{cli, codeModeHost}`。 */
export function locateCodexTools(resources, { windows = false } = {}) {
  const suffix = windows ? '.exe' : '';
  const matches = [];
  // CLI 与 code-mode 宿主必须来自同一已知布局；多套完整候选同样拒绝，避免混用版本。
  for (const base of ['.', 'codex-cli/bin']) {
    const cli = join(resources, base, `codex${suffix}`);
    const codeModeHost = join(resources, base, `codex-code-mode-host${suffix}`);
    if (regularFile(resources, cli) && regularFile(resources, codeModeHost)) matches.push({ cli, codeModeHost });
  }
  if (matches.length > 1) throw new Error(`Ambiguous original Codex CLI layout in application resources: ${resources}`);
  if (!matches.length) throw new Error(`Application is missing a complete original Codex CLI layout: ${resources}`);
  return matches[0];
}
