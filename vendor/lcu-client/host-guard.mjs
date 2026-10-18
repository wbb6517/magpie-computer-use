import { execFileSync } from 'node:child_process';

/**
 * Computer Use 可以点击任何已获授权应用中的按钮；若允许控制承载本代理授权提示的应用，
 * 代理就可能自行批准自己的请求。因此禁止授权此类宿主。原始运行时已拒绝 Terminal、
 * iTerm2 与 com.openai.codex；本守卫补充其他已知代理宿主，以及实际承载当前会话的应用。
 *
 * 上游保留的 LCU_ALLOW_AGENT_HOST_APPROVAL=1 仅供授权流程测试关闭本守卫；
 * 本包的运行时入口会拒绝该配置，正常使用时不能绕过。
 */
export const ALLOW_ENV = 'LCU_ALLOW_AGENT_HOST_APPROVAL';

/**
 * 固定名单仅包含专用代理宿主和终端。VS Code、Cursor、Windsurf、Antigravity、Zed
 * 等编辑器与 IDE 本身是常见的操作目标，因此只在父进程链证明其中的代理扩展
 * 正在承载当前会话时才拒绝授权，避免一概禁止普通编辑操作。
 */
export const KNOWN_AGENT_HOSTS = new Map([
  ['com.anthropic.claudefordesktop', 'Claude'],
  ['com.anthropic.claude-code', 'Claude Code'],
  ['com.openai.codex', 'Codex'],
  ['ai.opencode.desktop', 'OpenCode'],
  ['com.electron.factory', 'Factory'],
  ['com.nousresearch.hermes', 'Hermes'],
  ['com.apple.Terminal', 'Terminal'],
  ['com.googlecode.iterm2', 'iTerm2'],
  ['com.mitchellh.ghostty', 'Ghostty'],
  ['dev.warp.Warp-Stable', 'Warp'],
  ['dev.warp.Warp-Preview', 'Warp'],
  ['com.github.wez.wezterm', 'WezTerm'],
  ['org.alacritty', 'Alacritty'],
  ['net.kovidgoyal.kitty', 'kitty'],
  ['co.zeit.hyper', 'Hyper'],
  ['com.raphaelamorim.rio', 'Rio'],
  ['dev.commandline.waveterm', 'Wave'],
]);

const APP_MARKER = '.app/';

/** 从可执行路径提取包含它的最外层 .app 应用包目录；没有时返回 undefined。 */
export function appBundleOf(executablePath) {
  if (typeof executablePath !== 'string') return undefined;
  const index = executablePath.indexOf(APP_MARKER);
  return index < 0 ? undefined : executablePath.slice(0, index + APP_MARKER.length - 1);
}

/** 在 macOS 上通过 ps 查询进程的 {ppid, path}；查询失败返回 undefined。 */
export function psLookup(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-o', 'comm=', '-p', String(pid)],
      { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const match = /^(\d+)\s+(.+)$/.exec(out);
    return match ? { ppid: Number(match[1]), path: match[2] } : undefined;
  } catch {
    return undefined;
  }
}

/** 读取应用包的 CFBundleIdentifier；读取失败返回 undefined。 */
export function plistBundleId(bundle) {
  try {
    const id = execFileSync('plutil',
      ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', `${bundle}/Contents/Info.plist`],
      { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return id || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 沿父进程链收集承载此进程的所有最外层 .app 应用包。代理 CLI 自身也可能是应用包，
 * 真正的 GUI 宿主则位于更上层，故不能只检查直接父进程。LCU 使用的官方 Node 也可能
 * 位于应用包内，因此跳过与 execPath 同包的祖先进程。返回 {bundle, bundleId, name} 列表，
 * 无法确定时为空；各项查询均可注入，以便独立校验父链检测。
 */
export function findHostApps({
  pid = process.pid,
  execPath = process.execPath,
  lookup = psLookup,
  bundleId = plistBundleId,
  maxDepth = 64,
} = {}) {
  const found = [];
  try {
    const own = appBundleOf(execPath);
    const seen = new Set([pid]);
    let current = lookup(pid);
    for (let depth = 0; current && depth < maxDepth; depth++) {
      const parent = current.ppid;
      if (!Number.isInteger(parent) || parent <= 1 || seen.has(parent)) break;
      seen.add(parent);
      current = lookup(parent);
      if (!current) break;
      const bundle = appBundleOf(current.path);
      if (!bundle || bundle === own || found.some(host => host.bundle === bundle)) continue;
      const id = bundleId(bundle);
      if (id) found.push({ bundle, bundleId: id, name: bundle.slice(bundle.lastIndexOf('/') + 1, -4) });
    }
  } catch {
    // 查询失败时仍保留此前已经找到的宿主。
  }
  return found;
}

let detected;

/** 每个进程只检测一次宿主应用；非 macOS 或检测失败时返回空列表。 */
export function detectHostApps() {
  if (detected === undefined) detected = process.platform === 'darwin' ? findHostApps() : [];
  return detected;
}

function sameId(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

/** 返回禁止授权该应用（bundle id）的宿主名称；允许授权时返回 undefined。 */
export function agentHostReason(app, { hosts, env = process.env } = {}) {
  if (typeof app !== 'string' || !app || env?.[ALLOW_ENV] === '1') return undefined;
  for (const host of hosts ?? detectHostApps()) if (sameId(host.bundleId, app)) return host.name;
  for (const [id, name] of KNOWN_AGENT_HOSTS) if (sameId(id, app)) return name;
  return undefined;
}

/** 从原生应用授权请求提取应用 bundle id；不是此类请求时返回 undefined。 */
export function approvalApp(params) {
  const meta = params?._meta;
  const app = meta?.tool_params?.app;
  return meta?.connector_id === 'computer-use' && typeof app === 'string' && app ? app : undefined;
}

/**
 * 各适配器共享的授权守卫：在向宿主或用户询问之前，先拒绝承载代理的应用；其他请求返回 undefined。
 * report 接收拒绝原因，默认输出到 stderr；运行于 TUI 的共享客户端传入空函数。
 */
export function declineAgentHostApp(params, { report = message => console.error(message), ...options } = {}) {
  const app = approvalApp(params);
  if (!app) return undefined;
  const name = agentHostReason(app, options);
  if (!name) return undefined;
  report(`LCU does not allow computer use to control the app hosting this agent (${name}); ` +
    `declined approval for ${app}`);
  return { action: 'decline' };
}
