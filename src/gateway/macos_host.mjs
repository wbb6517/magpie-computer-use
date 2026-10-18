// 基于 amontlabs/lcu v0.11.4，提交 bf45b8edf01bc380def2ba8355b60a4ab5e1857d。
// Copyright (c) 2026 Amont Labs. MIT license; see LICENSE in this directory.
// 为一个 MCP 进程管理原始 macOS 客户端的 turn-ended 命令。
//
// 此宿主与其启动的原始服务共享生命周期，通过私有 Unix 套接字接收 Sky 包装层的轮次结束 ID，
// 调用原始客户端的 `turn-ended` 命令，并在有充分证据时恢复已过期的 Computer Use 服务。
// 上游未使用的人工控制通道已移除；本地改动见 SOURCES.md。
// 生命周期套接字仍用于轮次清理和过期服务恢复。
// 与启动链路的其他模块保持一致，通过 process.getBuiltinModule 获取内置模块。
const { spawn, spawnSync } = process.getBuiltinModule('node:child_process');
const fs = process.getBuiltinModule('node:fs');
const net = process.getBuiltinModule('node:net');
const { tmpdir } = process.getBuiltinModule('node:os');
const { basename, dirname, isAbsolute, join, sep } = process.getBuiltinModule('node:path');

import { tryExclusiveOpen } from './lock.mjs';

// 记录此宿主启动的所有系统工具和 turn-ended 命令，停止宿主时一并结束。
const running = new Set();
function track(child) {
  running.add(child);
  child.once('close', () => running.delete(child));
  return child;
}

export const SKY_SERVICE_NAME = 'SkyComputerUseService';
// 系统工具使用绝对路径，避免调用方的 PATH 将其替换。
export const PS = '/bin/ps';
export const LSOF = '/usr/sbin/lsof';
export const CODESIGN = '/usr/bin/codesign';
// `ps` 的启动时间只有整秒精度，文件时间则含亚秒精度；
// 因此距启动时间过近的文件变更不会被认定为应用更新。
const STALE_MARGIN_SECONDS = 2;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 将 `ps lstart` 的五个字段解析为 UTC 纪元秒数；格式错误时返回 null。 */
export function parseProcessStart(fields) {
  if (fields.length !== 5) return null;
  const [, monthName, dayText, clock, yearText] = fields;
  const month = MONTHS.indexOf(monthName);
  const parts = /^(\d+):(\d+):(\d+)$/.exec(clock);
  if (month < 0 || !parts || !/^\d+$/.test(dayText) || !/^\d+$/.test(yearText)) return null;
  const [hour, minute, second] = parts.slice(1).map(Number);
  const [day, year] = [Number(dayText), Number(yearText)];
  if (!(day >= 1 && day <= 31 && hour <= 23 && minute <= 59 && second <= 60 && year >= 1970 && year <= 9999)) return null;
  // `ps` 使用 TZ=UTC 运行，避免夏令时切换造成的本地时间歧义。
  return Date.UTC(year, month, day, hour, minute, second) / 1000;
}

const PROCESS_ROW = /^[ \t]*(\d+)[ \t]+(\d+)[ \t]+([A-Za-z]{3})[ \t]+([A-Za-z]{3})[ \t]+(\d{1,2})[ \t]+(\d{2}:\d{2}:\d{2})[ \t]+(\d{4})[ \t]+(\/.*)$/s;
// 拒绝会让一个路径看起来像多行或多个字段的控制字符。
const UNSAFE_PATH = /[\x00-\x1f\x7f\x85\u2028\u2029]/;

/**
 * 从 `ps -axo pid=,uid=,lstart=,comm=` 输出得到 `{services, unparsed}`。
 * 仅按换行分行；包含服务名但无法完整解析的行计入 unparsed，不推测其内容。
 */
export function parseProcessTable(text) {
  const services = [];
  let unparsed = 0;
  for (const line of text.split('\n')) {
    if (!line.includes(SKY_SERVICE_NAME)) continue;
    // 字段依次为 pid、uid、形如 `Wed Oct  7 00:34:53 2026` 的 lstart，以及可能含空格的可执行路径。
    const match = PROCESS_ROW.exec(line.replace(/\r$/, ''));
    const started = match ? parseProcessStart(match.slice(3, 8)) : null;
    const raw = match ? match[8] : ''; // 裁剪前先检查原值；只有末尾空格可视为填充
    const path = raw.replace(/ +$/, '');
    if (started === null || UNSAFE_PATH.test(raw) || !isAbsolute(path) || basename(path) !== SKY_SERVICE_NAME) {
      unparsed += 1;
      continue;
    }
    services.push({ pid: Number(match[1]), uid: Number(match[2]), path, started });
  }
  return { services, unparsed };
}

/**
 * 返回可执行文件、Info.plist 与代码签名封印的 ctime 秒数；缺失文件时返回 null。
 * 上游实测应用更新会替换整个包：这些文件的 ctime 为更新时间，而 mtime 与创建时间更早。
 * 采用三者中最早的时间判断整包替换，避免把单个文件的元数据变更误认成应用更新。
 */
export function bundleChangeTimes(executable, stat = fs.statSync) {
  const contents = dirname(dirname(executable));
  if (contents === dirname(contents)) return null;
  try {
    return [executable, join(contents, 'Info.plist'), join(contents, '_CodeSignature/CodeResources')]
      .map((path) => stat(path).ctimeMs / 1000);
  } catch {
    return null;
  }
}

/** 固定英文月份、UTC 时间和 UTF-8 路径；移除会截断路径的 COLUMNS。 */
function toolEnvironment(env = process.env) {
  const result = { ...env, LC_TIME: 'C', LC_CTYPE: 'UTF-8', TZ: 'UTC' };
  delete result.LC_ALL;
  delete result.COLUMNS;
  return result;
}

/**
 * 运行系统工具并返回 `{status, stdout, stderr}`，限制等待时间在 `timeout` 秒附近。
 * 内核中阻塞的工具可能在 SIGKILL 后仍未退出，因此发送信号一秒后即停止等待并拒绝 Promise。
 */
export function boundedRun(argv, { timeout, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = track(spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], env }));
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const expire = () => {
      const error = new Error(`${argv[0]} timed out after ${timeout} seconds`);
      error.code = 'ETIMEDOUT';
      return error;
    };
    let abandon;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      abandon = setTimeout(() => reject(expire()), 1000);
    }, timeout * 1000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (status) => {
      clearTimeout(timer);
      clearTimeout(abandon);
      if (abandon) reject(expire());
      else resolve({ status, stdout, stderr });
    });
  });
}

/** 通过 `ps` 返回运行中的 Sky 服务（或指定 `pid`）及未解析行数。 */
export async function listSkyServices({ run = boundedRun, pid } = {}) {
  const selection = pid === undefined ? ['-axo'] : ['-p', String(pid), '-o'];
  // -ww 表示不限宽度；否则无终端时 `ps` 会截断长路径，导致漏掉服务。
  const result = await run([PS, '-ww', ...selection, 'pid=,uid=,lstart=,comm='], { timeout: 2, env: toolEnvironment() });
  // 进程已消失时，`ps -p` 返回状态 1 且无输出，这是正常的空结果。
  if (result.status !== 0 && !(pid !== undefined && result.status === 1 && !result.stdout.trim())) {
    throw new Error(`ps exited with status ${result.status}.`);
  }
  return parseProcessTable(result.stdout);
}

/** 列出运行中的 Sky 服务，标记早于应用包替换时间启动的实例；此函数只诊断。 */
export async function diagnoseSkyServices({ run = boundedRun, stat = fs.statSync } = {}) {
  const { services, unparsed } = await listSkyServices({ run });
  return {
    unparsed,
    services: services.map((service) => {
      const times = bundleChangeTimes(service.path, stat);
      return { ...service, bundleTimes: times, stale: times !== null && Math.min(...times) > service.started + STALE_MARGIN_SECONDS };
    }),
  };
}

/** 同一时间只执行一次 `work`；期间到达的调用在有限等待时间内复用该次结果。 */
export function singleFlight(work, { waitSeconds = 5, unfinished = 'The Computer Use service recovery did not finish.' } = {}) {
  let current = null;
  return async (...args) => {
    let result;
    if (current) {
      result = await Promise.race([current.catch(() => null), new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000).unref())]);
    } else {
      current = Promise.resolve().then(() => work(...args));
      try {
        result = await current;
      } finally {
        current = null;
      }
    }
    return result || { ok: false, error: unfinished };
  };
}

// 应用包在运行期间被替换后，旧 Computer Use 服务可能仍持有套接字锁并拒绝所有客户端。
// 只有下方全部检查均证明同一个服务确为过期持锁者，才发送 SIGTERM 请求其退出，
// 让原始客户端启动当前版本。每一步均有超时边界，任何不确定结果都会取消恢复操作。
// 不依靠进程名或单一签名错误推断是否可以结束进程。
const CODESIGN_TIMEOUT_SECONDS = 4;
const LSOF_TIMEOUT_SECONDS = 3;
// 必须在从恢复开始计时的这一单调时钟预算内发送信号；请求方总共只等 15 秒，
// 其中还包括下方等待服务退出的时间。
export const SIGNAL_BUDGET_SECONDS = 9;
const PEER_LOCK_WAIT_SECONDS = 4;
const TERMINATE_WAIT_SECONDS = 3;
const TERMINATE_POLL_SECONDS = 0.1;
const RECOVERY_WAIT_SECONDS = 16;
// `codesign --verify <pid>` 在运行中代码与磁盘代码不一致时输出的特征文本
// （errSecCSStaticCodeChanged）；其他失败无法证明运行中的服务已过期。
export const SIGNATURE_MISMATCH_MARKERS = ['the code on disk does not match what is running'];
const SERVICE_EXECUTABLE = `Contents/MacOS/${SKY_SERVICE_NAME}`;

/** 返回 valid、invalid（运行中代码不同于磁盘代码）或 unknown。 */
export async function verifyServiceSignature(pid, { run = boundedRun } = {}) {
  let result;
  try {
    result = await run([CODESIGN, '--verify', '--strict', String(pid)], { timeout: CODESIGN_TIMEOUT_SECONDS, env: toolEnvironment() });
  } catch {
    return 'unknown';
  }
  if (result.status === 0) return 'valid';
  const detail = `${result.stderr ?? ''} ${result.stdout ?? ''}`.toLowerCase();
  return result.status === 1 && SIGNATURE_MISMATCH_MARKERS.some((marker) => detail.includes(marker)) ? 'invalid' : 'unknown';
}

/**
 * 返回打开服务套接字锁文件的完整 PID 集合；不能确定时返回 null。
 * 只接受无诊断文本的明确结果：有效 PID 列表，或 lsof 返回“未找到”状态且无 PID。
 */
export async function lockHolders(lockPath, { run = boundedRun } = {}) {
  if (!lockPath || !isAbsolute(lockPath)) return null;
  let result;
  try {
    result = await run([LSOF, '-t', '--', lockPath], { timeout: LSOF_TIMEOUT_SECONDS });
  } catch {
    return null;
  }
  const lines = (result.stdout ?? '').split(/\s+/).filter(Boolean);
  const clean = !(result.stderr ?? '').trim() && lines.every((line) => /^\d+$/.test(line)) &&
    ((result.status === 0 && lines.length > 0) || (result.status === 1 && !lines.length));
  return clean ? new Set(lines.map(Number)) : null;
}

const isPid = (pid) => Number.isInteger(pid) && pid > 1;

/**
 * 从内核信息确认 PID 实际运行的 Sky 服务可执行文件；不能确定时返回 null。
 * `ps` 显示的 argv[0] 可由进程自行设置，不能单独作为身份依据。Node 无法直接调用
 * proc_pidpath，因此通过 lsof 的文本映射获取相同的内核 vnode 信息，只接受唯一的
 * SkyComputerUseService 可执行文件，排除同进程映射的其他库。
 */
export async function executablePath(pid, { run = boundedRun } = {}) {
  if (process.platform !== 'darwin' || !isPid(pid)) return null;
  try {
    const result = await run([LSOF, '-a', '-p', String(pid), '-d', 'txt', '-Fn'], { timeout: LSOF_TIMEOUT_SECONDS });
    if (result.status !== 0 || (result.stderr ?? '').trim()) return null;
    const lines = result.stdout.split('\n');
    if (lines[0] !== `p${pid}`) return null;
    const names = lines.slice(1).filter((line) => line.startsWith('n')).map((line) => line.slice(1))
      .filter((name) => isAbsolute(name) && basename(name) === SKY_SERVICE_NAME);
    return names.length === 1 ? names[0] : null;
  } catch {
    return null;
  }
}

// 定时器不持有事件循环引用：尚在等待的恢复不会阻止已完成的网关进程退出。
const sleepSeconds = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000).unref());
const monotonicSeconds = () => performance.now() / 1000;

/**
 * 为当前账户的多个 LCU 宿主（每条 MCP 连接一个）提供恢复互斥。
 * 在账户私有临时目录的文件上持有 flock，覆盖检查与等待服务退出的整个阶段；
 * 该锁与 Python LCU 宿主兼容，持锁进程退出时由内核释放。文件还记录最近一次被请求退出的
 * 服务实例，避免对同一实例重复发送信号。其他宿主正在恢复时只有限等待；仅在 macOS 获取锁。
 */
export class PeerLock {
  constructor(path = PeerLock.defaultPath(), { waitSeconds = PEER_LOCK_WAIT_SECONDS, sleep = sleepSeconds, monotonic = monotonicSeconds } = {}) {
    Object.assign(this, { path, waitSeconds, sleep, monotonic, descriptor: null, acquired: false, previous: null });
  }

  /** 通过系统查询账户私有临时目录，避免依赖 $TMPDIR；非 macOS 返回 null。 */
  static defaultPath() {
    if (process.platform !== 'darwin') return null;
    const result = spawnSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8', timeout: 5000 });
    const directory = result.status === 0 ? result.stdout.trim() : '';
    return isAbsolute(directory) ? join(directory, `lcu-stale-service-recovery-${process.getuid()}.lock`) : null;
  }

  async acquire() {
    if (!this.path || process.platform !== 'darwin') return this;
    const deadline = this.monotonic() + this.waitSeconds;
    for (;;) {
      let descriptor;
      try {
        descriptor = tryExclusiveOpen(this.path);
      } catch {
        return this;
      }
      if (descriptor === null) {
        if (this.monotonic() >= deadline) return this;
        await this.sleep(0.05);
        continue;
      }
      this.descriptor = descriptor;
      this.acquired = true;
      this.previous = this.read();
      return this;
    }
  }

  read() {
    try {
      const buffer = Buffer.alloc(1024);
      const record = JSON.parse(buffer.subarray(0, fs.readSync(this.descriptor, buffer, 0, 1024, 0)).toString('utf8'));
      return record && typeof record === 'object' && !Array.isArray(record) ? record : null;
    } catch {
      return null;
    }
  }

  /** 为下一位持锁者保存 `outcome`；只有完整写入并回读一致时才返回 true。 */
  record(outcome) {
    try {
      const data = Buffer.from(JSON.stringify(outcome));
      fs.ftruncateSync(this.descriptor, 0);
      // 短写（如触发文件大小限制）会留下无法读取的记录，必须视为失败。
      if (fs.writeSync(this.descriptor, data, 0, data.length, 0) !== data.length) return false;
      const back = Buffer.alloc(data.length + 1);
      return back.subarray(0, fs.readSync(this.descriptor, back, 0, back.length, 0)).equals(data);
    } catch {
      return false;
    }
  }

  /** 关闭文件描述符以释放锁。 */
  release() {
    if (this.descriptor === null) return;
    fs.closeSync(this.descriptor);
    this.descriptor = null;
  }
}

/**
 * 返回允许停止服务的两个已知应用包中的可执行文件：启动使用的副本与应用的副本。
 * 若实际可执行路径解析后逃逸出对应应用包，则不纳入允许集合。
 */
export function knownServiceExecutables(env = process.env, realpath = (path) => { try { return fs.realpathSync(path); } catch { return path; } }) {
  const bundles = [env.SKY_CUA_SERVICE_PATH];
  if (env.CODEX_HOME) bundles.push(join(env.CODEX_HOME, 'computer-use', 'Codex Computer Use.app'));
  const executables = new Set();
  for (const bundle of bundles) {
    if (!bundle || !isAbsolute(bundle)) continue;
    const root = realpath(bundle);
    const executable = realpath(join(bundle, SERVICE_EXECUTABLE));
    if (basename(executable) === SKY_SERVICE_NAME && executable !== root && executable.startsWith(root.endsWith(sep) ? root : root + sep)) {
      executables.add(executable);
    }
  }
  return executables;
}

/** 通过信号 0 检查进程是否存在，不实际投递信号；pid 必须指向单个进程。 */
export function processExists(pid) {
  if (!isPid(pid)) throw new Error('refusing to probe a non-process id');
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

const sameSet = (set, value) => set instanceof Set && set.size === 1 && set.has(value);
const sameTimes = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/**
 * 仅请求退出已被证明过期、且独占当前连接锁的那一个 Computer Use 服务。
 * 依次验证以下条件；任一步失败或无法得出结论都不会发送信号：
 * 1. 当前账户只有此宿主进行恢复，且互斥锁覆盖服务退出等待阶段；
 * 2. 进程列表完整，恰有一个服务早于其应用包替换时间启动；
 * 3. 该服务是当前用户的单个进程（pid > 1 且不是本进程），名称严格匹配
 *    SkyComputerUseService，列出的路径与内核确认的可执行路径均属于已知应用包；
 * 4. 尚未请求该实例（由 PID 和启动时间共同标识）退出；
 * 5. 它独占套接字锁，且 codesign 确认运行中代码与磁盘代码不一致；
 * 6. 先完整记录退出请求；记录失败则不发送信号，后续取消发送时恢复旧记录；
 * 7. 发送前再次核对持锁者、包变更时间、进程与内核可执行路径，并确认预算未超时、请求方仍在等待。
 * 全部通过后只向该 PID 发送 SIGTERM，最多等 3 秒并记录结果，不对进程组操作，也不使用 SIGKILL。
 * 最后一次读取与发送信号之间仍存在 PID 被复用的极小窗口，macOS 没有可消除此窗口的进程句柄。
 */
export async function recoverStaleService({
  lockPath, executables, uid = process.getuid(), diagnose = diagnoseSkyServices, readProcess = listSkyServices,
  changeTimes = bundleChangeTimes, verify = verifyServiceSignature, holders = lockHolders, kernelPath = executablePath,
  kill = (pid, signal) => process.kill(pid, signal), exists = processExists, realpath = knownRealpath,
  sleep = sleepSeconds, monotonic = monotonicSeconds, exclusive = () => new PeerLock(), waiting = () => false, log,
} = {}) {
  const nothing = (reason) => ({ ok: true, recovered: false, reason });
  const started = monotonic();
  let peer;
  let pid;
  let path;
  let exited = false;
  let elapsedMs;
  try {
    peer = await exclusive().acquire();
    if (!peer.acquired) return nothing('another LCU process is recovering');
    const diagnosis = await diagnose();
    if (diagnosis.unparsed) return nothing('the process listing was incomplete');
    // 仅考虑当前账户的服务；其他用户的服务不能持有本账户的锁。
    const stale = diagnosis.services.filter((item) => item.stale && item.uid === uid);
    if (!stale.length) return nothing('no stale service');
    if (stale.length !== 1) return nothing('more than one stale service');
    const [service] = stale;
    ({ pid, path } = service);
    const start = service.started;
    if (!isPid(pid) || pid === process.pid) return nothing('not a single service process');
    if (basename(path) !== SKY_SERVICE_NAME || !executables.has(realpath(path))) {
      return nothing('the stale service is not in a known Computer Use bundle');
    }
    const kernel = await kernelPath(pid);
    if (!(kernel && basename(kernel) === SKY_SERVICE_NAME && realpath(kernel) === realpath(path))) {
      return nothing('the kernel does not report the known executable for the stale service');
    }
    const previous = peer.previous ?? {};
    // 同一实例只请求退出一次；若 SIGTERM 后仍存活，也不会重复干预。
    if (previous.pid === pid && previous.started === start) return nothing('this service was already asked to quit');
    if (!sameSet(await holders(lockPath), pid)) return nothing('the stale service is not the only holder of the socket lock');
    if (await verify(pid) !== 'invalid') {
      return nothing('the running service passes signature verification, or it could not be checked');
    }
    if (!peer.record({ pid, started: start })) return nothing('the attempt could not be recorded');
    let reason = null;
    try {
      if (!sameSet(await holders(lockPath), pid)) reason = 'the socket lock changed hands while it was being checked';
      else if (!sameTimes(changeTimes(path), service.bundleTimes)) reason = 'the service bundle changed while it was being checked';
      else {
        const { services: rows, unparsed } = await readProcess({ pid }); // 最后重新读取进程本身
        if (unparsed || rows.length !== 1 || rows[0].pid !== pid || rows[0].uid !== service.uid ||
            rows[0].started !== start || rows[0].path !== path || await kernelPath(pid) !== kernel) {
          reason = 'the service changed while it was being checked';
        } else if (monotonic() - started > SIGNAL_BUDGET_SECONDS) reason = 'the checks took too long to act on';
        else if (!waiting()) reason = 'the request stopped waiting for the recovery';
      }
    } catch (error) {
      reason = `check failed: ${String(error?.message ?? error).slice(0, 200)}`;
    }
    if (reason) {
      // 恢复旧记录，保留先前已请求退出的实例信息。
      peer.record(peer.previous ?? {});
      return nothing(reason);
    }
    kill(pid, 'SIGTERM');
    try {
      const deadline = monotonic() + TERMINATE_WAIT_SECONDS;
      while (!exited && monotonic() < deadline) {
        exited = !exists(pid);
        if (!exited) await sleep(TERMINATE_POLL_SECONDS);
      }
    } finally {
      elapsedMs = Math.trunc((monotonic() - started) * 1000);
      log?.(`LCU macOS sent SIGTERM to stale Computer Use service pid ${pid} (${path}); ` +
        (exited ? `it exited after ${elapsedMs} ms` : `it did not exit within ${TERMINATE_WAIT_SECONDS} seconds`));
    }
  } catch (error) {
    return nothing(`check failed: ${String(error?.message ?? error).slice(0, 200)}`);
  } finally {
    peer?.release?.();
  }
  if (!exited) return nothing(`pid ${pid} did not exit within ${TERMINATE_WAIT_SECONDS} seconds of SIGTERM`);
  return { ok: true, recovered: true, pid, path, elapsed_ms: elapsedMs };
}

function knownRealpath(path) {
  try {
    return fs.realpathSync(path);
  } catch {
    return path;
  }
}

/** 使用当前宿主环境为一个请求方尝试恢复；非 macOS 不执行恢复。 */
export function recoverResponse(waiting = () => false, env = process.env) {
  if (process.platform !== 'darwin') return Promise.resolve({ ok: true, recovered: false, reason: 'not macOS' });
  return recoverStaleService({ lockPath: env.LCU_MAC_SERVICE_LOCK, executables: knownServiceExecutables(env), waiting,
    log: (line) => process.stderr.write(`${line}\n`) });
}

// 原始辅助程序会启动 CUAService 应用，XPC 连接最长等待 5 秒，正常运行约需 5.2 秒。
// 这里为较慢的启动留出余量；macos_sky_service.mjs 的等待时间须高于此值。
export const TURN_ENDED_CLI_TIMEOUT_SECONDS = 10;
// 宿主停止时，仍未结束的轮次各自在此时限内执行 turn-ended 命令；所有命令并行启动。
export const STOP_TURN_ENDED_TIMEOUT_SECONDS = 8;
// 保存的未结束轮次数与 Sky 包装层的元数据上限一致；达到上限时淘汰最早记录。
const OPEN_TURN_LIMIT = 128;
// 成功命令仅在耗时接近辅助程序自身的 5 秒期限时记录日志。
const TURN_ENDED_CLI_SLOW_SECONDS = 4.5;
const STDERR_LOG_BYTES = 512;

const turnEndedPayload = (sessionId, turnId) =>
  JSON.stringify({ type: 'agent-turn-complete', 'thread-id': sessionId, 'turn-id': turnId });

/**
 * 执行原始 turn-ended 命令，并在 stderr 报告慢调用或失败。
 * 辅助程序连接不到服务时也可能返回 0（只写入 os_log），因此退出码 0 不能证明通知已送达。
 */
export async function runTurnEnded(client, payload, { timeout = TURN_ENDED_CLI_TIMEOUT_SECONDS, slowSeconds = TURN_ENDED_CLI_SLOW_SECONDS } = {}) {
  const started = performance.now();
  const { status, stderr, failure } = await new Promise((resolve) => {
    const output = [];
    let child;
    try {
      child = track(spawn(client, ['turn-ended', payload], { stdio: ['ignore', 'ignore', 'pipe'] }));
    } catch (error) {
      resolve({ status: 'launch-failed', stderr: Buffer.from(error.message), failure: `could not start: ${error.code ?? error.message}` });
      return;
    }
    child.stderr.on('data', (chunk) => output.push(chunk));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ status: 'timeout', stderr: Buffer.concat(output), failure: `timed out after ${timeout} seconds` });
    }, timeout * 1000);
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ status: 'launch-failed', stderr: Buffer.from(error.message), failure: `could not start: ${error.code ?? error.message}` });
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const exit = code ?? signal;
      resolve({ status: exit, stderr: Buffer.concat(output), failure: exit === 0 ? null : `exited with status ${exit}` });
    });
  });
  const elapsed = (performance.now() - started) / 1000;
  if (failure || elapsed >= slowSeconds) {
    const text = new TextDecoder().decode(stderr.subarray(0, STDERR_LOG_BYTES)).trim();
    process.stderr.write(`LCU macOS turn-ended command: exit=${status} elapsed=${Math.round(elapsed * 1000)} ms` +
      `${text ? ` stderr=${JSON.stringify(text)}` : ''}\n`);
  }
  if (failure) throw new Error(`Original turn-ended command ${failure}.`);
}

/** 从套接字读取按换行分隔的 JSON；`next(limit)` 返回下一行解析结果，并限制帧大小。 */
function lineReader(socket) {
  let buffered = Buffer.alloc(0);
  let waiter = null;
  let ended = null;
  const settle = () => {
    if (!waiter) return;
    const newline = buffered.indexOf(0x0a);
    if (newline > waiter.limit || (newline < 0 && buffered.length > waiter.limit)) {
      waiter.reject(new Error('Invalid macOS host request size or framing.'));
    } else if (newline >= 0) {
      const line = buffered.subarray(0, newline);
      buffered = buffered.subarray(newline + 1);
      try {
        waiter.resolve(JSON.parse(line.toString('utf8')));
      } catch (error) {
        waiter.reject(error);
      }
    } else if (ended) {
      waiter.reject(ended);
    } else return;
    waiter = null;
  };
  socket.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    settle();
  });
  socket.on('end', () => {
    ended = new Error('macOS host connection closed before a complete request.');
    settle();
  });
  socket.on('error', (error) => {
    ended = error;
    settle();
  });
  return (limit = 4096) => new Promise((resolve, reject) => {
    waiter = { resolve, reject, limit };
    settle();
  });
}

const send = (socket, value) => new Promise((resolve) => {
  if (socket.destroyed || !socket.writable) {
    resolve(false);
    return;
  }
  socket.write(`${JSON.stringify(value)}\n`, (error) => resolve(!error));
});

function listen(address) {
  return new Promise((resolve, reject) => {
    // 允许半关闭，让已停止发送或等待的请求方仍有机会接收响应。
    const server = net.createServer({ allowHalfOpen: true });
    server.sockets = new Set();
    server.on('connection', (socket) => {
      server.sockets.add(socket);
      socket.on('close', () => server.sockets.delete(socket));
    });
    server.once('error', reject);
    server.listen(address, () => {
      server.off('error', reject);
      try {
        fs.chmodSync(address, 0o600);
      } catch (error) {
        server.close();
        reject(error);
        return;
      }
      // 接收连接错误（如 EMFILE）只记录日志，不应使整个网关进程退出。
      server.on('error', (error) => process.stderr.write(`LCU macOS host socket error: ${error.message}\n`));
      resolve(server);
    });
  });
}

const closeServer = (server, address) => new Promise((resolve) => {
  server.close(() => resolve());
  for (const socket of server.sockets) socket.destroy();
}).finally(() => fs.rmSync(address, { force: true }));

/**
 * 为一条 MCP 连接提供私有生命周期套接字；可以接收连接后返回 `{address, stop()}`。
 * 轮次结束 ID 触发原始客户端命令；`turn` 将轮次记为待结束，供 stop() 兜底清理；
 * `recover` 在正常请求路径之外启动或复用过期服务恢复。
 */
export async function startOriginalHost({ client, env = process.env, recover = recoverResponse }) {
  try {
    fs.accessSync(client, fs.constants.X_OK);
    if (!fs.statSync(client).isFile()) throw new Error('not a file');
  } catch {
    throw new Error('The selected original macOS computer-use client is incomplete.');
  }
  const base = fs.existsSync('/private/tmp') ? '/private/tmp' : tmpdir();
  const folder = fs.mkdtempSync(join(base, 'lcu-ml-'));
  const address = join(folder, 'lifetime.sock');
  const recovery = singleFlight((waiting) => recover(waiting, env), { waitSeconds: RECOVERY_WAIT_SECONDS });
  // 保存 Sky 包装层已报告、但尚未收到 turn-ended 请求的轮次。worker 在 js_reset 或服务退出时会消失，
  // 届时已注册的结束钩子也会丢失，Sky 可能一直保留该轮次的事件监听。
  // stop() 因而需要逐个调用原始命令，清理这些仍然打开的轮次。
  const openTurns = new Map();
  let server;
  try {
    server = await listen(address);
  } catch (error) {
    fs.rmSync(folder, { recursive: true, force: true });
    throw new Error(`Original macOS lifecycle host failed to become ready: ${error.message}`);
  }
  server.on('connection', async (socket) => {
    socket.setTimeout(3000, () => socket.destroy());
    socket.on('error', () => {});
    const next = lineReader(socket);
    let response;
    try {
      const request = await next();
      if (request?.type === 'recover') {
        // 在普通请求路径之外等待 codesign、lsof 和服务退出。
        socket.setTimeout(0);
        let waiting = true;
        const stop = () => { waiting = false; };
        socket.on('data', stop).on('end', stop).on('close', stop).on('error', stop);
        const result = await recovery(() => waiting && !socket.destroyed);
        socket.setTimeout(3000, () => socket.destroy());
        await send(socket, result);
        socket.end();
        return;
      }
      const sessionId = request?.session_id;
      const turnId = request?.turn_id;
      if (typeof sessionId !== 'string' || !sessionId.trim() || typeof turnId !== 'string' || !turnId.trim()) {
        throw new Error('Original macOS turn IDs are missing.');
      }
      const key = JSON.stringify([sessionId, turnId]);
      if (request.type === 'turn') {
        openTurns.delete(key);
        openTurns.set(key, { sessionId, turnId });
        if (openTurns.size > OPEN_TURN_LIMIT) openTurns.delete(openTurns.keys().next().value);
        await send(socket, { ok: true });
        socket.end();
        return;
      }
      openTurns.delete(key);
      socket.setTimeout(0);
      await runTurnEnded(client, turnEndedPayload(sessionId, turnId));
      response = { notified: true };
    } catch (error) {
      response = { notified: false, error: String(error?.message ?? error).slice(0, 512) };
      process.stderr.write(`LCU macOS turn cleanup failed: ${response.error}\n`);
    }
    // 钩子客户端断开连接不能导致宿主停止。
    await send(socket, response);
    socket.end();
  });
  return {
    address,
    /**
     * 结束此宿主创建的全部资源：先在 STOP_TURN_ENDED_TIMEOUT_SECONDS 内并行清理未结束轮次，
     * 再结束剩余 turn-ended 命令和系统工具。恢复等待不会持有事件循环引用，
     * 使网关能随原始服务及时退出。
     */
    async stop() {
      const open = [...openTurns.values()];
      openTurns.clear();
      if (open.length) {
        process.stderr.write(`LCU macOS host: ending ${open.length} turn(s) still open at exit\n`);
        await Promise.allSettled(open.map(({ sessionId, turnId }) => runTurnEnded(client,
          turnEndedPayload(sessionId, turnId), { timeout: STOP_TURN_ENDED_TIMEOUT_SECONDS })));
      }
      for (const child of running) child.kill('SIGKILL');
      await closeServer(server, address);
      fs.rmSync(folder, { recursive: true, force: true });
    },
  };
}
