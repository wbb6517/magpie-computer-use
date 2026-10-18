export const instructions = 'Original CUA instructions: preserve initialization and native approvals.';
export const tools = ['js', 'js_reset'].map(name => ({ name,
  description: `Original ${name} descriptor`, inputSchema: { type: 'object', properties: { code: { type: 'string' } } } }));
export const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFWQAAAAASUVORK5CYII=';
export const imageResult = { content: [{ type: 'text', text: 'original text' },
  { type: 'image', data: png, mimeType: 'image/png' }], isError: false, _meta: { original: true } };
export const errorResult = { content: [{ type: 'text', text: 'original runtime refusal' }], isError: true };

export function fixtureFactory(events, options = {}) {
  return ({ onElicitation, command }) => ({
    instructions,
    async connect() { events.push({ event: 'connect', command }); },
    publicTools() { return tools; },
    async call(name, args, context) {
      events.push({ event: 'call', name, args, sessionId: context.sessionId, turnId: context.turnId,
        toolCallId: context.toolCallId, metadata: context.metadata });
      if (args.code === 'hang') {
        await new Promise((_, reject) => {
          const abort = () => reject(context.signal.reason ?? new Error('aborted'));
          if (context.signal.aborted) abort();
          else context.signal.addEventListener('abort', abort, { once: true });
        });
      }
      if (args.code === 'approval') {
        const response = await onElicitation({ mode: 'form', message: 'Allow the original app?',
          requestedSchema: { type: 'object', properties: {} },
          _meta: { connector_id: 'computer-use', codex_approval_kind: 'mcp_tool_call',
            tool_params: { app: options.app ?? 'com.apple.finder' }, persist: ['session', 'always'] },
        }, { signal: context.signal });
        events.push({ event: 'approval', response });
        return { content: [{ type: 'text', text: JSON.stringify(response) }] };
      }
      if (args.code === 'progress') {
        context.onprogress({ progressToken: 'upstream-private-token', progress: 1, total: 2, message: 'original progress' });
      }
      if (args.code === 'fail') return errorResult;
      return imageResult;
    },
    async turnEnded(identity) {
      if (options.cleanupFailure) throw new Error('fixture cleanup failed');
      if (options.cleanupDelay) await new Promise(resolve => setTimeout(resolve, options.cleanupDelay));
      events.push({ ...identity, hookEvent: identity.event, event: 'turnEnded' });
    },
    async close() { events.push({ event: 'close' }); },
  });
}
