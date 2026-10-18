/**
 * 工作流 ⑥：运行在官方 worker 中的 Sky 包装器。它把动作委托给原始 service.handleRpc()，
 * 并登记轮次结束钩子；原生应用访问策略、进程认证与系统操作仍由官方服务负责。
 */
// 基于 amontlabs/lcu v0.11.4，提交 bf45b8edf01bc380def2ba8355b60a4ab5e1857d。
// Copyright (c) 2026 Amont Labs. MIT license; see LICENSE in this directory.
// 转发原始 Sky 服务；仅对原生键盘路径会丢字的 type_text 文本进行分段适配，
// 将相关片段送至原始且受应用策略校验的 paste 方法。
// 同时通过私有短生命周期套接字，把原始轮次结束钩子转交给签名验证过的 macOS 客户端。
// 上游未使用的 status/Stop 控制路由已移除；本地改动见 SOURCES.md。
// 原始应用的权限与策略校验仍由原始服务负责。
import {pathToFileURL} from 'node:url';
import {Buffer} from 'node:buffer';

let original;
let nativeClient;
let registered = false;
const pendingCleanup = new Map();
let cleanupInFlight;
const TURN_METADATA_LIMIT = 128;
// 原始 node_repl 宿主只等待轮次结束处理器 5 秒，之后会判定轮次失败。
// 此处应在该期限前返回；较慢的清理继续在后台运行，
// finishPendingCleanup() 会让下一条 Sky 请求先等待这些清理完成。
const TURN_CLEANUP_HOOK_TIMEOUT_MS = 4_000;
// 私有生命周期宿主的等待上限：TURN_ENDED_CLI_TIMEOUT_SECONDS（10 秒，见 macos_host.mjs）
// 再加 2 秒套接字往返余量，必须大于宿主执行原始命令的上限。
export const LIFETIME_SIGNAL_TIMEOUT_MS = 12_000;
// 原始命令失败后，在下一条 Sky 请求时重试一次，之后不再保留。
const CLI_CLEANUP_ATTEMPTS = 2;
const TURN_ENDED_TIMEOUT_SECONDS = 15;
const turnMetadata = new Map();
// 累计已执行的轮次结束钩子。请求开始后若出现任何轮次结束（Stop 或 Interrupt），
// 即使恢复过期服务成功，也不会继续重试、登记或发送该请求。
let turnsEnded = 0;

function lifetimeSignal(runtime, session_id, turn_id) {
  const address = runtime.env.LCU_MAC_LIFETIME_SOCKET;
  if (!address || typeof runtime.nativePipe?.createConnection !== 'function') {
    throw Error('Original macOS native-pipe lifetime channel is unavailable');
  }
  // 建立连接本身也有时限，避免永不完成的连接将后续请求全部阻塞在清理阶段。
  // 若连接在超时后才建立，也要立即关闭，避免遗留资源。
  const connecting = Promise.resolve().then(() => runtime.nativePipe.createConnection(address));
  let connectTimer;
  const connectDeadline = new Promise((_, reject) => {
    connectTimer = setTimeout(() => {
      connecting.then(late => { try { late.end(); } catch {} }, () => {});
      reject(Error('macOS native turn cleanup connection timed out'));
    }, 4000);
  });
  return Promise.race([connecting, connectDeadline]).finally(() => clearTimeout(connectTimer)).then(socket => new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    let finished = false;
    const timer = setTimeout(() => finish(Error('macOS native turn cleanup timed out')), LIFETIME_SIGNAL_TIMEOUT_MS);
    function finish(error, result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.end();
      if (error) reject(error); else resolve(result);
    }
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
      if (data.length > 4096) return finish(Error('macOS native cleanup response is too large'));
      const newline = data.indexOf(10);
      if (newline < 0) return;
      try {
        const result = JSON.parse(data.subarray(0, newline).toString('utf8'));
        if (!result || result.notified !== true) {
          throw Error(result?.error || 'Original macOS turn-ended command failed');
        }
        finish(null, true);
      } catch (error) { finish(error); }
    });
    socket.on('error', error => finish(error));
    socket.on('close', () => finish(Error('macOS native cleanup channel closed')));
    socket.write(Buffer.from(JSON.stringify({session_id, turn_id}) + '\n'));
  }));
}

// 提前通知私有宿主该轮次已打开；即便 worker 因 js_reset 或服务退出而先于轮次消失，
// 宿主仍能补发结束通知。仅尽力发送，不等待，也不向调用方抛错。
function announceTurn(runtime, session_id, turn_id) {
  const address = runtime?.env?.LCU_MAC_LIFETIME_SOCKET;
  if (!address || typeof runtime.nativePipe?.createConnection !== 'function') return;
  Promise.resolve().then(() => runtime.nativePipe.createConnection(address)).then(socket => {
    const timer = setTimeout(() => { try { socket.end(); } catch {} }, 2000);
    const done = () => { clearTimeout(timer); try { socket.end(); } catch {} };
    socket.on('data', done);
    socket.on('error', done);
    socket.on('close', () => clearTimeout(timer));
    socket.write(Buffer.from(JSON.stringify({type: 'turn', session_id, turn_id}) + '\n'));
  }).catch(() => {});
}

// 只匹配原始传输错误的完整消息；验证或授权错误中即使包含这些词，
// 也不能视为原生管道启动失败而触发恢复。
const NATIVE_PIPE_FAILURE = 'Sky Computer Use native pipe startup failed';
// 失败请求等待宿主尝试恢复的上限；宿主内部的检查和服务退出等待
// 都限制在这个总时限以内。
const RECOVER_TIMEOUT_MS = 15_000;
let recovering;

// 请求私有宿主恢复过期的 Computer Use 服务；只有证明服务确已过期、持有当前连接锁，
// 且属于允许结束的实例时才请求其退出。确认服务已退出后，宿主才返回 recovered: true。
// 此函数也只有在该情况下才返回 true。
// 不拒绝 Promise，且等待不超过 RECOVER_TIMEOUT_MS；放弃时关闭连接，
// 宿主观察到请求方不再等待后就不会发送信号。
function askHostToRecover(runtime) {
  const address = runtime?.env?.LCU_MAC_LIFETIME_SOCKET;
  if (!address || typeof runtime.nativePipe?.createConnection !== 'function') {
    return Promise.resolve(false);
  }
  // 测试可配置更短的等待，但不得超过 RECOVER_TIMEOUT_MS。
  const configured = Number(runtime.env.LCU_MAC_RECOVER_TIMEOUT_MS);
  const timeoutMs = configured > 0 ? Math.min(configured, RECOVER_TIMEOUT_MS) : RECOVER_TIMEOUT_MS;
  return new Promise(resolve => {
    let socket;
    let finished = false;
    let data = Buffer.alloc(0);
    const timer = setTimeout(() => finish(false), timeoutMs);
    function finish(recovered) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { socket?.end(); } catch {}
      resolve(recovered === true);
    }
    Promise.resolve().then(() => runtime.nativePipe.createConnection(address)).then(connection => {
      if (finished) {
        try { connection.end(); } catch {}
        return;
      }
      socket = connection;
      socket.on('data', chunk => {
        data = Buffer.concat([data, Buffer.from(chunk)]);
        if (data.length > 65536) return finish(false);
        const newline = data.indexOf(10);
        if (newline < 0) return;
        try {
          const result = JSON.parse(data.subarray(0, newline).toString('utf8'));
          finish(result?.ok === true && result.recovered === true);
        } catch { finish(false); }
      });
      socket.on('error', () => finish(false));
      socket.on('close', () => finish(false));
      socket.write(Buffer.from(JSON.stringify({type: 'recover'}) + '\n'));
    }).catch(() => finish(false));
  });
}

// 同一时间只进行一次恢复，并发失败复用同一结果。
function recoverOnce(runtime) {
  recovering ??= askHostToRecover(runtime).finally(() => { recovering = undefined; });
  return recovering;
}

// 执行 attempt；仅在明确的原生管道启动失败、宿主成功恢复过期服务，
// 且 beforeRetry 仍允许重试时，再执行一次。其余情况原样抛出首次错误。
// 单次重试本身或 beforeRetry 的失败则抛出它们自己的错误，
// 不用恢复过程替换实际操作的失败原因。
async function withStaleServiceRecovery(runtime, attempt, beforeRetry = async () => true) {
  try {
    return await attempt();
  } catch (error) {
    let recovered = false;
    try {
      recovered = typeof error?.message === 'string' && error.message === NATIVE_PIPE_FAILURE &&
        await recoverOnce(runtime);
    } catch {}
    if (!recovered || !(await beforeRetry(error))) throw error;
  }
  return attempt();
}

function register() {
  if (registered) return;
  const runtime = globalThis.nodeRepl;
  if (typeof runtime?.addTurnEndedHandler !== 'function') {
    throw Error('Original node_repl turn-ended hook is unavailable');
  }
  runtime.addTurnEndedHandler({timeoutMs: TURN_CLEANUP_HOOK_TIMEOUT_MS, run: async event => {
    // 先累计次数，确保下方即使拒绝该结束事件，也会阻止恢复后的重试。
    turnsEnded++;
    const {session_id, turn_id} = event ?? {};
    if (typeof session_id !== 'string' || !session_id.trim() ||
        typeof turn_id !== 'string' || !turn_id.trim()) {
      // 缺少归属信息的轮次结束事件会停止所有分段请求。
      for (const listener of turnEndListeners) listener(undefined);
      throw Error('Original node_repl turn IDs are missing');
    }
    const key = JSON.stringify([session_id, turn_id]);
    for (const listener of turnEndListeners) listener(key);
    const item = pendingCleanup.get(key) ?? {
      key, session_id, turn_id,
      metadata: turnMetadata.get(key),
      nativeNotified: false,
      cliFailures: 0,
    };
    pendingCleanup.set(key, item);
    turnMetadata.delete(key);
    // 钩子只等待原生确认；原始 CLI 命令约需 5 秒，因此在后台继续执行，
    // 下一条 Sky 请求再等待它完成。
    await nativeCleanup(item);
    finishPendingCleanup().catch(() => {});
  }});
  registered = true;
}

function readTurnMetadata(runtime) {
  try {
    const raw = runtime.requestMeta?.['x-codex-turn-metadata'];
    let metadata = raw;
    if (raw instanceof Uint8Array) metadata = JSON.parse(Buffer.from(raw).toString('utf8'));
    if (typeof raw === 'string') metadata = JSON.parse(raw);
    if (!metadata || typeof metadata !== 'object' ||
        typeof metadata.session_id !== 'string' || !metadata.session_id.trim() ||
        typeof metadata.turn_id !== 'string' || !metadata.turn_id.trim()) return undefined;
    return JSON.parse(JSON.stringify(metadata));
  } catch { return undefined; }
}

const SLOW_CLEANUP_STEP_MS = 1_000;
// 清理步骤若一直不结束（如原始传输阻塞于 LaunchServices），不能持续阻塞后续所有请求。
// 设置硬超时；测试时可以配置更短的上限。
const CLEANUP_STEP_HARD_TIMEOUT_MS = 20_000;

// 标明耗时的清理步骤，便于将宿主的 turn-ended handlers timed out
// 归因到原生 IPC 或 CLI 辅助程序；只有钩子实际等待的步骤
// 才需要这个慢调用观察定时器。
async function timedCleanupStep(step, run, {hookWaits = false} = {}) {
  const started = Date.now();
  // 宿主约 5 秒后就停止等待钩子，需在此前指出仍在运行的步骤。
  const watchdog = hookWaits ? setTimeout(() => {
    console.error(`LCU macOS turn cleanup step "${step}" is still running after ${Date.now() - started} ms`);
  }, TURN_CLEANUP_HOOK_TIMEOUT_MS) : undefined;
  let hardTimer;
  const hardLimit = Number(globalThis.nodeRepl?.env?.LCU_MAC_CLEANUP_STEP_TIMEOUT_MS);
  const hardMs = hardLimit > 0 ? Math.min(hardLimit, CLEANUP_STEP_HARD_TIMEOUT_MS) : CLEANUP_STEP_HARD_TIMEOUT_MS;
  try {
    return await Promise.race([run(), new Promise((_, reject) => {
      hardTimer = setTimeout(() => reject(Error(`macOS turn cleanup step "${step}" timed out after ${hardMs} ms`)), hardMs);
    })]);
  } finally {
    clearTimeout(hardTimer);
    clearTimeout(watchdog);
    const ms = Date.now() - started;
    if (ms >= SLOW_CLEANUP_STEP_MS) {
      console.error(`LCU macOS turn cleanup step "${step}" took ${ms} ms`);
    }
  }
}

// 通过原始原生 IPC 确认轮次结束；同一条目上的并发调用
// （结束钩子与下一条 Sky 请求）共享同一次尝试。
function nativeCleanup(item) {
  if (!item.metadata || item.nativeNotified) return Promise.resolve();
  item.nativeAttempt ??= timedCleanupStep('native IPC turn-ended', async () => {
    // 将首次冷导入客户端的时间也计入该步骤。
    const {MacComputerUseClient} = await import(pathToFileURL(
      globalThis.nodeRepl.env.LCU_MAC_SKY_CLIENT_PATH).href);
    nativeClient ??= new MacComputerUseClient();
    return nativeClient.request('ComputerUseIPCCodexTurnEndedRequest', {
      threadID: item.session_id,
      turnID: item.turn_id,
    }, {codexMetadata: item.metadata, timeoutSeconds: TURN_ENDED_TIMEOUT_SECONDS});
  }, {hookWaits: true}).then(() => { item.nativeNotified = true; })
    .finally(() => { item.nativeAttempt = undefined; });
  return item.nativeAttempt;
}

// 执行一次原始 CLI 命令；失败不向外抛出，而是保留条目待下次重试一次。
// 再次失败后丢弃：此时原生结束步骤已经确认，
// 辅助程序故障不应无限阻断后续 Computer Use 操作。
async function cliCleanup(item) {
  const started = Date.now();
  try {
    await timedCleanupStep('CLI turn-ended', () =>
      lifetimeSignal(globalThis.nodeRepl, item.session_id, item.turn_id));
    pendingCleanup.delete(item.key);
  } catch (error) {
    item.cliFailures += 1;
    const ms = Date.now() - started;
    const where = `${item.session_id}/${item.turn_id}`;
    const reason = String(error?.message ?? error).slice(0, 256);
    if (item.cliFailures < CLI_CLEANUP_ATTEMPTS) {
      console.error(`LCU macOS turn cleanup: original turn-ended command failed for ${where} after ${ms} ms (${reason}); retrying once at the next Sky request`);
      return;
    }
    pendingCleanup.delete(item.key);
    const native = item.metadata ? 'native turn-ended was acknowledged'
      : 'no native turn-ended was needed';
    console.error(`LCU macOS turn cleanup: original turn-ended command failed for ${where} after ${ms} ms; ${native}; continuing`);
  }
}

async function runCleanup(retryFailed) {
  const attempted = new Set();
  let nativeFailure;
  for (;;) {
    // 每轮重新扫描，以拾取清理期间新结束的轮次；已经失败过的命令
    // 只在 Sky 请求触发时重试。
    const item = [...pendingCleanup.values()].find(candidate =>
      !attempted.has(candidate) && (retryFailed || candidate.cliFailures === 0));
    if (!item) break;
    attempted.add(item);
    try { await nativeCleanup(item); }
    catch (error) { nativeFailure ??= error; continue; }
    await cliCleanup(item);
  }
  if (nativeFailure) throw nativeFailure;
}

// 清理串行执行。结束钩子先启动后台清理，Sky 请求等待该轮结束后，
// 再带 retryFailed 执行一轮，重试先前失败的命令。
function finishPendingCleanup({retryFailed = false} = {}) {
  // 原始运行时可能在钩子失败后仍报告 MCP 成功；因此保留原生清理记录，
  // 直到得到宿主确认，并在执行后续操作前重试。
  const current = cleanupInFlight;
  if (current && (current.retryFailed || !retryFailed)) return current.promise;
  const run = {retryFailed};
  run.promise = (current ? current.promise.catch(() => {}) : Promise.resolve())
    .then(() => runCleanup(retryFailed))
    .finally(() => { if (cleanupInFlight === run) cleanupInFlight = undefined; });
  cleanupInFlight = run;
  return run.promise;
}

// 等待中的清理即将完成时仍可能出现新的轮次结束，发送请求前必须再次确认
// 没有尚待原生确认的轮次。
async function gateOnCleanup() {
  do {
    await finishPendingCleanup({retryFailed: true});
  } while ([...pendingCleanup.values()].some(item => item.metadata && !item.nativeNotified));
}

// 原始 macOS type_text 将每个字符映射为当前键盘布局中的按键，
// 没有对应按键的字符会静默丢失，例如韩文、emoji、AZERTY 布局中的 ñ
// （openai/codex#27494）。因此以控制字符为界切分文本：
// Return、Tab、CRLF 等控制片段仍使用原始 type_text，保留按键语义；
// 其间只要包含码点大于 127 的字符，就整段交给原始 paste 作为纯文本粘贴，
// 其他片段继续 type_text。字素簇不会跨越控制字符边界，
// 因而不会把一个字符拆开；孤立代理项仍按原样转交，
// 与原始方法收到的内容一致。不需要适配的请求
// 返回 undefined。
function unicodeTextSegments(request) {
  if (request?.type !== 'execute' || request.method !== 'type_text' ||
      !Array.isArray(request.args) || request.args.length < 1) return undefined;
  const input = request.args[0];
  if (!input || typeof input !== 'object') return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(input);
  // 不合法的访问器输入交由原始应用策略校验器处理；在可信 worker 内适配请求时
  // 不得求值调用方提供的访问器。
  if (Object.values(descriptors).some(property => !('value' in property))) return undefined;
  const text = descriptors.text?.value;
  if (typeof text !== 'string' || !/[^\0-\x7f]/.test(text)) return undefined;
  const runs = [];
  for (const chunk of text.split(/([\x00-\x1f\x7f]+)/)) {
    if (!chunk) continue;
    const paste = /[^\0-\x7f]/.test(chunk);
    // 相邻的键入片段（如一行及其后的 Return）合并为一次 type_text。
    if (!paste && runs.at(-1)?.paste === false) runs.at(-1).text += chunk;
    else runs.push({paste, text: chunk});
  }
  // 各片段保留调用方的属性描述符与其余参数，只替换 text；
  // 粘贴片段额外声明纯文本格式。
  // 不修改调用方的原始请求对象。
  return runs.map(({paste, text}) => {
    const segment = {...descriptors, text: {...descriptors.text, value: text}};
    if (paste) segment.format = {value: 'text', enumerable: true};
    return {...request, method: paste ? 'paste' : 'type_text',
      args: [Object.defineProperties({}, segment), ...request.args.slice(1)]};
  });
}

// 分段请求整体串行排队，避免不同请求的片段交错输入。
let segmentQueue = Promise.resolve();
const turnEndListeners = new Set();

/** 官方 worker 通过 trusted-services 的 sky 映射进入这里；处理完清理前置步骤后委托原始服务。 */
export async function handleRpc(request) {
  register();
  const runtime = globalThis.nodeRepl;
  // 恢复后只有在请求启动以来没有轮次结束时，才允许重试、登记并发送请求；
  // 否则返回引发恢复的那条原始错误。
  const startedAt = turnsEnded;
  const turnsActive = () => turnsEnded === startedAt;
  const state = {recoveryError: undefined, resent: false};
  // 从分段请求一开始就记录此后结束的轮次，
  // 确保请求自身的轮次无论何时结束都能被观察到。
  const segments = unicodeTextSegments(request);
  const endedTurns = new Set();
  const listener = key => endedTurns.add(key);
  if (segments) turnEndListeners.add(listener);
  const retryIfActive = async error => {
    // 每次恢复都重新标记“恢复后尚未发送”；只有随后实际发送才会再次设置 resent。
    state.recoveryError = error;
    state.resent = false;
    return turnsActive();
  };
  try {
    // 重试轮次清理也访问同一条原生管道，会以相同方式失败，因此也进入同一恢复流程。
    await withStaleServiceRecovery(runtime, gateOnCleanup, retryIfActive);
    original ??= import(pathToFileURL(runtime.env.LCU_MAC_SKY_SERVICE_PATH).href);
    // 登记行为与原流程一致；但若恢复后又出现轮次结束，
    // 就不再登记新的轮次元数据。
    const blocked = () => Boolean(state.recoveryError) && !turnsActive();
    const metadata = blocked() ? undefined : readTurnMetadata(runtime);
    if (metadata) {
      const key = JSON.stringify([metadata.session_id, metadata.turn_id]);
      if (!turnMetadata.has(key) && turnMetadata.size >= TURN_METADATA_LIMIT) {
        throw Error('Too many active macOS turn metadata contexts; refusing a new Sky request until turn cleanup completes');
      }
      if (!turnMetadata.has(key)) announceTurn(runtime, metadata.session_id, metadata.turn_id);
      turnMetadata.set(key, metadata);
    }
    const service = await original;
    // 紧接下方发送执行检查，中间不再等待异步操作。
    if (blocked()) throw state.recoveryError;
    // 重试也必须像其他请求一样，先等待未完成的轮次清理。
    const dispatch = segment => withStaleServiceRecovery(runtime, () => {
      if (state.recoveryError) state.resent = true;
      return service.handleRpc(segment);
    }, async error => {
      if (!(await retryIfActive(error))) return false;
      await gateOnCleanup();
      return turnsActive();
    });
    if (!segments) return await dispatch(request);
    // 按顺序发送片段，各自拥有独立的过期服务恢复尝试。该错误发生在打开原生管道时，
    // 此时片段动作尚未写入，所以单次重试只重发当前片段，
    // 不重发已经送达的早期片段。恢复状态归属于整个请求：
    // 每次恢复清除 resent，后续发送再设置它；
    // 因而轮次结束后，仅在最近一次恢复以来未发送任何动作时返回恢复前的错误。
    // 当前请求所属轮次结束（Stop 或 Interrupt）后不再发送后续片段；
    // 其他轮次（如子代理）结束不会直接停止当前输入，但与普通请求一致，
    // 任一轮次结束都会禁止过期服务恢复后的重试。缺少轮次元数据时，任一轮次结束
    // 都停止当前输入。其他轮次结束之后发送片段前，需像新请求一样等待其清理完成。
    // 请求开始后排队的清理都已通过钩子记录到 endedTurns，
    // 更早的清理则已在上方等待；
    // 任一片段出错即终止整段序列，不退回会丢字的键盘输入方式。
    const ownKey = metadata && JSON.stringify([metadata.session_id, metadata.turn_id]);
    const stopped = () => ownKey ? endedTurns.has(ownKey) || endedTurns.has(undefined) : !turnsActive();
    const run = segmentQueue.then(async () => {
      let result;
      const stop = () => Error('macOS text input stopped: the turn ended before every segment was sent');
      for (const segment of segments) {
        if (stopped()) throw stop();
        if (endedTurns.size) {
          await withStaleServiceRecovery(runtime, gateOnCleanup, retryIfActive);
          if (stopped()) throw stop();
        }
        result = await dispatch(segment);
      }
      return result;
    });
    segmentQueue = run.catch(() => {});
    return await run;
  } catch (error) {
    // 若恢复后尚未发送动作就遇到轮次结束，无论后续哪里失败，都返回引发恢复的错误；
    // 已经发送的重试则保留其自身错误。
    throw state.recoveryError && !turnsActive() && !state.resent ? state.recoveryError : error;
  } finally {
    turnEndListeners.delete(listener);
  }
}
