/** 工作流 ④：十工具到原始 cua API 的映射层；这里只生成脚本，执行发生在官方 REPL 中。 */
import { createHash } from 'node:crypto';

// 十个原生 Computer Use 操作的兼容接口。
// 所有动作都通过已验证的 cua-repl API 执行，并遵守原始应用策略与用户授权。
const app = { type: 'string', minLength: 1, description: '应用名称、绝对 .app 路径或明确的 bundle identifier。' };
const index = { type: 'string', pattern: '^[0-9]+$', description: '最近一次界面状态中的元素索引。' };
const text = { type: 'string' };
const number = { type: 'number' };
const object = (properties, required = []) => ({ type: 'object', properties, additionalProperties: false, ...(required.length ? { required } : {}) });
const tool = (name, description, properties, required) => ({ name, description, inputSchema: object(properties, required) });
// 这是 Agent 在 tools/list 中看到的公开协议；实际执行由下方 nativeCall() 映射。
export const NATIVE_TOOLS = [
  tool('list_apps', '列出本机运行或近期使用过的应用。', {}),
  tool('get_app_state', '选择应用并按原始流程请求授权，返回其当前窗口的界面树和截图。操作应用前先调用；需要新截图时再次调用。', { app }, ['app']),
  tool('click', '按最新界面的元素索引或截图坐标点击，并返回更新后的界面状态。', { app, element_index: index, x: number, y: number, click_count: { type: 'integer', minimum: 1 }, mouse_button: { type: 'string', enum: ['left','right','middle'] } }, ['app']),
  tool('perform_secondary_action', '执行最新界面树中该元素明确提供的辅助操作，并返回更新状态。', { app, element_index: index, action: { ...text, minLength: 1 } }, ['app','element_index','action']),
  tool('set_value', '设置可编辑界面元素的值，并返回更新状态。', { app, element_index: index, value: text }, ['app','element_index','value']),
  tool('select_text', '选中界面中的文字，或把光标放到文字前后；重复文字可用 prefix/suffix 消歧。', { app, element_index: index, text, prefix: text, suffix: text, selection: { type: 'string', enum: ['text','cursor_before','cursor_after'] } }, ['app','element_index','text']),
  tool('scroll', '对界面元素按方向滚动指定页数，并返回更新状态。', { app, element_index: index, direction: { type: 'string', enum: ['up','down','left','right'] }, pages: { type: 'number', exclusiveMinimum: 0 } }, ['app','element_index','direction']),
  tool('drag', '按截图像素坐标拖动，并返回更新状态。', { app, from_x: number, from_y: number, to_x: number, to_y: number }, ['app','from_x','from_y','to_x','to_y']),
  tool('press_key', '发送按键或组合键，例如 Return、Tab、super+c，并返回更新状态。', { app, key: { ...text, minLength: 1 } }, ['app','key']),
  tool('type_text', '向应用输入原样文字，并返回更新状态。', { app, text }, ['app','text']),
];
export const NATIVE_TOOL_NAMES = new Set(NATIVE_TOOLS.map(tool => tool.name));
export const NATIVE_INSTRUCTIONS = `This MCP exposes ten native Computer Use operations. Use list_apps to discover apps, then get_app_state to request access and obtain the current screenshot and accessibility indices before interacting. Each action returns updated accessibility state; call get_app_state for a fresh screenshot. The underlying runtime's documentation may refer to JavaScript/cua_repl; these tools already wrap that API, so call the named native tools directly. App authorization remains the original user's decision. Contexts are isolated by MCP connection unless the host supplies actual turn metadata.`;

// 在生成脚本前按工具定义检查参数，拒绝未知字段、不完整坐标及不安全的元素索引。
function validate(name, args) {
  const definition = NATIVE_TOOLS.find(tool => tool.name === name);
  if (!definition) throw new Error(`Unknown native Computer Use tool: ${name}`);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object');
  const schema = definition.inputSchema;
  for (const field of schema.required ?? []) if (args[field] === undefined) throw new Error(`Missing ${field}`);
  for (const [field, value] of Object.entries(args)) {
    const rule = schema.properties[field];
    if (!rule) throw new Error(`Unknown argument: ${field}`);
    if (rule.type === 'string' && (typeof value !== 'string' || (rule.minLength && value.trim().length < rule.minLength))) throw new Error(`${field} must be a nonempty string`);
    if (rule.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error(`${field} must be a finite number`);
    if (rule.type === 'integer' && (!Number.isSafeInteger(value) || value < (rule.minimum ?? -Infinity))) throw new Error(`${field} must be a positive integer`);
    if (rule.enum && !rule.enum.includes(value)) throw new Error(`Invalid ${field}`);
    if (rule.exclusiveMinimum !== undefined && value <= rule.exclusiveMinimum) throw new Error(`${field} must be greater than ${rule.exclusiveMinimum}`);
    if (rule.pattern && (!new RegExp(rule.pattern).test(value) || !Number.isSafeInteger(Number(value)))) throw new Error(`${field} must be a valid element index`);
  }
  if (name === 'click' && args.element_index === undefined && (args.x === undefined || args.y === undefined)) throw new Error('click requires element_index or both x and y');
  if (name === 'click' && args.element_index !== undefined && (args.x !== undefined || args.y !== undefined)) throw new Error('click accepts an element index or coordinates, not both');
}

/** 将用户值编码为 JSON 数据并套入固定操作模板，避免把输入文字解释为可执行代码。 */
export function nativeCall(name, args, { sessionId, turnId } = {}) {
  validate(name, args);
  // 应用发现不需要预先选中目标；其余操作必须关联同一连接/轮次下的应用对象。
  if (name === 'list_apps') return { code: 'await cua.listApps();', title: '列出应用' };
  if (!sessionId || !turnId) throw new Error('Native operations require the current connection context');
  // 缓存键同时包含会话、轮次和应用，防止复用其他上下文的应用对象与界面元素索引。
  const binding = `__magpieNative_${createHash('sha256').update(JSON.stringify([sessionId, turnId, args.app])).digest('hex')}`;
  // 字符串与选项统一按数据引用；元素索引先经校验并归一为数字，再进入固定调用表达式。
  const literal = JSON.stringify;
  const target = args.element_index === undefined ? `[${literal(args.x)}, ${literal(args.y)}]` : String(Number(args.element_index));
  const calls = {
    click: `await target.click(${target}, ${literal({ clickCount: args.click_count ?? 1, mouseButton: args.mouse_button ?? 'left' })});`,
    perform_secondary_action: `await target.performSecondaryAction(${Number(args.element_index)}, ${literal(args.action)});`,
    set_value: `await target.setValue(${Number(args.element_index)}, ${literal(args.value)});`,
    select_text: `await target.selectText(${Number(args.element_index)}, ${literal(args.text)}, ${literal({ prefix: args.prefix, suffix: args.suffix, selectionType: args.selection ?? 'text' })});`,
    scroll: `await target.scroll(${Number(args.element_index)}, ${literal(args.direction)}, ${literal(args.pages ?? 1)});`,
    drag: `await target.drag([${literal(args.from_x)}, ${literal(args.from_y)}], [${literal(args.to_x)}, ${literal(args.to_y)}]);`,
    press_key: `await target.pressKey(${literal(args.key)});`,
    type_text: `await target.typeText(${literal(args.text)});`,
  };
  // 原始 REPL 会为每个 cell 重新初始化该 cell 声明的 var。仅在选应用时声明对应绑定，
  // 后续操作直接读取，避免重复的 Map 声明把上一调用保存的目标清空。
  // get_app_state 通过 cua.getApp() 触发原始访问策略并保存目标；后续动作复用目标。
  // 传入的元素索引来自该目标的最新界面树，动作完成后再读取一次界面树给 Agent。
  const body = name === 'get_app_state'
    ? `${binding} = await cua.getApp(${literal(args.app)});\nawait ${binding}.getScreenshot();`
    : `if (typeof ${binding} === 'undefined') throw new Error('Call get_app_state for this app in the current context before interacting');\nconst target = ${binding};\n${calls[name]}\nawait target.getAXState();`;
  const declaration = name === 'get_app_state' ? `var ${binding};\n` : '';
  return { code: `${declaration}await (async () => {\n${body}\n})();`, title: name };
}
