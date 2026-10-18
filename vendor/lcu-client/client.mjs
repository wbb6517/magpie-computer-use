// 基于 LCU v0.11.4；来源、许可与本地改动见 PATCHES.md、LICENSE。
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { declineAgentHostApp } from './host-guard.mjs';

export const MODEL_TOOLS = new Set(['js', 'js_reset']);

/** 清理与工具调用的默认超时；js 的请求运行时间更长时会相应延长。 */
export const TURN_END_TIMEOUT_MS = 120_000;

/** 计算工具调用时限；为 js 请求的运行时间额外预留完成与传输余量。 */
export function callTimeout(name, args) {
  const requested = Number(args?.timeout_ms);
  return name === 'js' && Number.isFinite(requested) && requested > 0
    ? Math.max(TURN_END_TIMEOUT_MS, requested + 30_000)
    : TURN_END_TIMEOUT_MS;
}

/** 宿主启动并列出工具的最长等待；SDK 默认的 60 秒不足以覆盖高负载启动。 */
export const CONNECT_TIMEOUT_MS = 120_000;

/** Node 支持的最大定时器延迟；授权等待由用户答复或取消终止。 */
export const APPROVAL_TIMEOUT_MS = 2 ** 31 - 1;

/** 统计待处理的授权请求，让工具调用在等待用户决定期间暂停计时。 */
export function createApprovalGate() {
  let pending = 0;
  const listeners = new Set();
  const notify = () => { for (const listener of [...listeners]) listener(); };
  return {
    get pending() { return pending; },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async track(run) {
      pending++;
      notify();
      try { return await run(); } finally {
        pending--;
        notify();
      }
    },
  };
}

/** 在可暂停的期限内执行 run(signal)；存在待答复授权时不消耗剩余时间。 */
export async function callWithDeadline(gate, timeout, signal, run) {
  const controller = new AbortController();
  const forward = () => controller.abort(signal.reason);
  if (signal?.aborted) forward();
  else signal?.addEventListener('abort', forward, { once: true });
  let remaining = timeout;
  let started;
  let timer;
  const sync = () => {
    if (gate.pending > 0) {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
      remaining -= Date.now() - started;
    } else if (timer === undefined) {
      started = Date.now();
      timer = setTimeout(() => controller.abort(
        McpError.fromError(ErrorCode.RequestTimeout, 'Request timed out', { timeout })),
      Math.max(remaining, 0));
    }
  };
  const unsubscribe = gate.onChange(sync);
  sync();
  try {
    return await run(controller.signal);
  } finally {
    unsubscribe();
    clearTimeout(timer);
    signal?.removeEventListener('abort', forward);
  }
}

// 只对已配置的精确 HTTP(S) origin 复用授权；路径、非标准来源或其他授权类型都继续交给宿主。
function originApproval(params, allowedOrigins) {
  const meta = params?._meta ?? params?.meta;
  if (meta?.tool_name !== 'access_browser_origin' || typeof meta.origin !== 'string') return false;
  let origin;
  try {
    const url = new URL(meta.origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== meta.origin) return false;
    origin = url.origin;
  } catch {
    return false;
  }
  return allowedOrigins.has(origin);
}

const STDERR_LINE_CHARS = 8192;
const STDERR_TAIL_LINES = 5;
const STDERR_TAIL_CHARS = 1000;

/**
 * 持续读取原始进程的 stderr 管道，防止写满管道后阻塞子进程。
 * 不直接转发到宿主 stderr，只在内存保留有上限的最后几行，供启动失败时解释原因。
 */
export function drainUpstreamStderr(stream) {
  const tail = [];
  let pending = '';
  let skipping = false;
  const line = text => {
    const trimmed = text.replace(/\r$/, '');
    if (!trimmed.trim()) return;
    tail.push(trimmed.slice(0, STDERR_TAIL_CHARS));
    if (tail.length > STDERR_TAIL_LINES) tail.shift();
  };
  if (stream) {
    stream.setEncoding?.('utf8');
    stream.on('data', chunk => {
      let text = String(chunk);
      for (;;) {
        const newline = text.indexOf('\n');
        if (newline < 0) break;
        if (!skipping) line(pending + text.slice(0, newline));
        pending = '';
        skipping = false;
        text = text.slice(newline + 1);
      }
      if (skipping) return;
      pending += text;
      if (pending.length > STDERR_LINE_CHARS) {
        // 对无限长的行仅保留开头，在下一次换行前丢弃剩余内容。
        line(pending.slice(0, STDERR_LINE_CHARS));
        pending = '';
        skipping = true;
      }
    });
    stream.on('end', () => {
      if (pending && !skipping) line(pending);
      pending = '';
    });
    stream.on('error', () => {});
  }
  return {
    /** 返回有长度上限的最后几行，仅用于启动失败的错误信息。 */
    tail() {
      const text = tail.join('\n');
      return text.length > STDERR_TAIL_CHARS ? text.slice(-STDERR_TAIL_CHARS) : text;
    },
  };
}

/** 为 js_reset 保存的宿主轮次数上限，优先淘汰最早记录。 */
export const MAX_WORKER_TURNS = 1024;

/**
 * js_reset 会停止原始可信 worker，连同其轮次结束钩子和已运行 js 的轮次数据一起销毁。
 * 如果之后才通知轮次结束，就无人接收，Sky 会持续保留事件监听；macOS 的键盘焦点监听
 * 甚至可能造成系统级重复按键。因此 reset(end) 必须在旧 worker 仍存活时先结束这些轮次，
 * 再分配新的上游轮次 ID，避免后续调用因沿用已结束的 ID 被拒绝。
 * 宿主以 (session, turn) 标识轮次，upstreamId 映射到原始服务实际收到的 ID。
 */
export function createWorkerTurns({ limit = MAX_WORKER_TURNS } = {}) {
  let worker = 0;
  // key -> { sessionId, upstreamId, worker }；worker 表示该轮次最近执行 js 时的 worker 代数。
  const turns = new Map();
  const key = (sessionId, turnId) => JSON.stringify([sessionId, turnId]);
  return {
    upstreamId(sessionId, turnId) { return turns.get(key(sessionId, turnId))?.upstreamId ?? turnId; },
    ranJs(sessionId, turnId) {
      const id = key(sessionId, turnId);
      const turn = turns.get(id) ?? { sessionId, upstreamId: turnId };
      turn.worker = worker;
      turns.delete(id);
      turns.set(id, turn);
      if (turns.size > limit) turns.delete(turns.keys().next().value);
    },
    ended(sessionId, turnId) { turns.delete(key(sessionId, turnId)); },
    async reset(end) {
      const used = [...turns.values()].filter(turn => turn.worker === worker);
      worker++;
      await Promise.all(used.map(async turn => {
        // 即使旧轮次的结束通知失败，也继续重置 worker。
        try { await end(turn.sessionId, turn.upstreamId); } catch {}
        turn.upstreamId = randomUUID();
        turn.worker = undefined;
      }));
    },
  };
}

/** 原始宿主停止等待清理时，turnEnded 抛出错误所带的代码。 */
export const TURN_CLEANUP_TIMEOUT_CODE = 'LCU_TURN_CLEANUP_TIMEOUT';

/** 只提供传输与生命周期桥接；CUA 操作行为由已安装的原始服务实现。 */
export function createCuaClient({
  command, cwd, env, onElicitation, allowedOrigins = [],
}) {
  if (!Array.isArray(command) || command.length === 0 || command.some(part => typeof part !== 'string' || !part)) {
    throw new TypeError('command must be a nonempty argv array');
  }
  const approved = new Set(allowedOrigins.map(origin => {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
      throw new TypeError(`Expected an exact HTTP(S) origin: ${origin}`);
    }
    return origin;
  }));
  const transport = new StdioClientTransport({
    command: command[0], args: command.slice(1), cwd,
    // 持续排空 stderr 管道，同时避免运行时输出混入宿主界面。
    env: env ?? process.env, stderr: 'pipe',
  });
  const upstreamStderr = drainUpstreamStderr(transport.stderr);
  const client = new Client({ name: 'lcu-harness-adapter', version: '0.1.0' }, {
    capabilities: { elicitation: {} },
  });
  let connected = false;
  let tools;
  const approvals = createApprovalGate();
  const callSignals = new Set();
  const workerTurns = createWorkerTurns();
  client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
    const params = request.params;
    // 先拒绝代理自身宿主，再判断预先配置的浏览器来源，其余请求通过原始授权回调处理。
    const refused = declineAgentHostApp(params, { report() {} });
    const origin = !refused && originApproval(params, approved);
    return refused ?? (origin ? { action: 'accept', content: {} } : await answerElicitation(params, extra));
  });
  async function answerElicitation(params, extra) {
    if (typeof onElicitation !== 'function') return { action: 'cancel' };
    // 将原始授权请求与当前工具调用的取消合并；取消后返回 cancel，避免遗留待答复请求。
    const signal = AbortSignal.any([extra.signal, ...callSignals]);
    const aborted = new Promise(resolve => {
      if (signal.aborted) resolve({ action: 'cancel' });
      else signal.addEventListener('abort', () => resolve({ action: 'cancel' }), { once: true });
    });
    const answer = await approvals.track(() => Promise.race([onElicitation(params, { signal }), aborted]));
    if (answer?.action === 'accept' || answer?.action === 'decline' || answer?.action === 'cancel') return answer;
    return { action: 'cancel' };
  }

  async function endTurnUpstream(sessionId, upstreamId, event) {
    return client.callTool({ name: 'turn_ended', arguments: {
      hook_event_name: event, session_id: sessionId, turn_id: upstreamId,
    } }, undefined, { timeout: TURN_END_TIMEOUT_MS });
  }
  return {
    async connect() {
      if (connected) return this;
      try {
        await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
        connected = true;
        const listed = await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS });
        tools = listed.tools.filter(tool => MODEL_TOOLS.has(tool.name));
        if (tools.length !== MODEL_TOOLS.size) throw new Error('Original CUA js/js_reset tools are missing');
        return this;
      } catch (error) {
        connected = false;
        // 启动或工具发现失败也要关闭传输，再附上有界 stderr 尾部，保留原始失败原因。
        await client.close().catch(() => {});
        const output = upstreamStderr.tail();
        if (output && error instanceof Error && !error.message.includes(output)) {
          error.message += `\nOriginal CUA MCP process stderr (last lines):\n${output}`;
        }
        throw error;
      }
    },
    get instructions() {
      if (!connected) throw new Error('LCU is not connected');
      return client.getInstructions() ?? '';
    },
    publicTools() {
      if (!connected) throw new Error('LCU is not connected');
      return tools;
    },
    async call(name, args, {
      sessionId, turnId, toolCallId, itemId, threadId, threadSource,
      chatgptConversationId, model, reasoningEffort, metadata, signal, onprogress,
    } = {}) {
      if (!connected) throw new Error('LCU is not connected');
      if (!MODEL_TOOLS.has(name)) throw new Error(`Tool is reserved for host use: ${name}`);
      // 要求宿主传入实际会话与活动轮次；不在工具侧伪造身份，以保持授权、动作和结束通知的归属一致。
      if (!sessionId || !turnId) throw new Error('A real host session and active turn are required');
      const timeout = callTimeout(name, args);
      // 必须先于下方元数据组装，确保重置调用自身已经携带该轮次的新上游 ID。
      if (name === 'js_reset') {
        await workerTurns.reset((session, upstreamId) => endTurnUpstream(session, upstreamId, 'Interrupt'));
      } else workerTurns.ranJs(sessionId, turnId);
      const inherited = metadata?.['x-codex-turn-metadata'];
      const original = typeof inherited === 'string' ? (() => {
        try { return JSON.parse(inherited); } catch { return undefined; }
      })() : inherited;
      const turnMetadata = original && typeof original === 'object' && !Array.isArray(original)
        ? { ...original } : {};
      // 宿主明确传入的身份覆盖继承元数据，避免旧请求中的 session/turn 误用于本次动作。
      Object.assign(turnMetadata, {
        session_id: sessionId,
        turn_id: workerTurns.upstreamId(sessionId, turnId),
        ...(toolCallId ? { call_id: toolCallId } : {}),
        ...(itemId ? { item_id: itemId } : {}),
        ...(threadId ? { thread_id: threadId } : {}),
        ...(threadSource ? { thread_source: threadSource } : {}),
        ...(chatgptConversationId ? { chatgpt_conversation_id: chatgptConversationId } : {}),
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      });
      if (signal) callSignals.add(signal);
      try {
        return await callWithDeadline(approvals, timeout, signal, deadlineSignal => client.callTool({
          name, arguments: args, _meta: {
            ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}),
            'x-codex-turn-metadata': turnMetadata,
          },
        }, undefined, { signal: deadlineSignal, timeout: APPROVAL_TIMEOUT_MS, onprogress }));
      } finally {
        if (signal) callSignals.delete(signal);
      }
    },
    async turnEnded({ sessionId, turnId, event = 'Stop' }) {
      if (!connected) return;
      if (!sessionId || !turnId || !['Stop', 'Interrupt', 'SubagentStop'].includes(event)) {
        throw new Error('Invalid original CUA lifecycle event');
      }
      const result = await endTurnUpstream(sessionId, workerTurns.upstreamId(sessionId, turnId), event);
      if (result.isError) {
        const detail = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
        if (/turn-ended handlers timed out/i.test(detail)) {
          // 原始宿主约 5 秒后停止等待；清理仍在 worker 中继续，
          // 下一次动作前还会再次尝试完成。
          const timeout = new Error('Original CUA turn cleanup did not finish within the host\'s wait; it may still be ' +
            'finishing in the background and will be retried before the next action.');
          timeout.code = TURN_CLEANUP_TIMEOUT_CODE;
          throw timeout;
        }
        throw new Error(`Original CUA turn cleanup failed: ${detail || 'unknown error'}`);
      }
      workerTurns.ended(sessionId, turnId);
      return result;
    },
    async close() {
      connected = false;
      await client.close();
    },
  };
}
