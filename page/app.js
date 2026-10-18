'use strict';
(() => {
const DEFAULTS = Object.freeze({
  appPath: '/Applications/ChatGPT.app',
  chrome: false,
  requestTimeoutMs: 120_000,
  idleTimeoutMs: 300_000,
});

function currentOptions(raw) {
  const opts = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    appPath: typeof opts.appPath === 'string' ? opts.appPath : DEFAULTS.appPath,
    chrome: typeof opts.chrome === 'boolean' ? opts.chrome : DEFAULTS.chrome,
    requestTimeoutMs: typeof opts.requestTimeoutMs === 'number' ? opts.requestTimeoutMs : DEFAULTS.requestTimeoutMs,
    idleTimeoutMs: typeof opts.idleTimeoutMs === 'number' ? opts.idleTimeoutMs : DEFAULTS.idleTimeoutMs,
  };
}

async function mountPage({ document, magpie }) {
  const get = id => document.getElementById(id);
  const form = get('settings-form');
  const save = get('save-settings');
  const status = get('save-state');
  const error = get('page-error');
  const fields = {
    appPath: get('app-path'), chrome: get('chrome'),
    requestTimeoutMs: get('request-timeout'), idleTimeoutMs: get('idle-timeout'),
  };
  const controls = Object.values(fields);
  const state = (message, kind = 'idle') => {
    status.textContent = message;
    status.dataset.state = kind;
  };
  const showError = message => {
    error.textContent = message;
    error.hidden = !message;
  };
  const enable = enabled => {
    save.disabled = !enabled;
    for (const field of controls) field.disabled = !enabled;
  };
  const paint = opts => {
    const o = currentOptions(opts);
    fields.appPath.value = o.appPath;
    fields.chrome.checked = o.chrome;
    fields.requestTimeoutMs.value = String(o.requestTimeoutMs / 1000);
    fields.idleTimeoutMs.value = String(o.idleTimeoutMs / 60_000);
  };
  const theme = value => {
    if (!value) return;
    document.documentElement.dataset.theme = value.dark ? 'dark' : 'light';
    if (value.lang) document.documentElement.lang = value.lang;
    for (const [key, token] of Object.entries(value.tokens ?? {})) {
      if (/^[a-z][a-z0-9-]*$/.test(key) && typeof token === 'string') {
        document.documentElement.style.setProperty(`--magpie-${key}`, token);
      }
    }
  };

  enable(false);
  try {
    if (!magpie?.ready || !magpie.options?.get || !magpie.options?.set) throw new Error('页面需要从 magpie 的插件侧边栏打开。');
    const initialTheme = await magpie.ready;
    theme(magpie.theme ?? initialTheme);
    magpie.onTheme?.(theme);
    paint(await magpie.options.get());
    state('设置已读取');
    enable(true);
  } catch (e) {
    paint(DEFAULTS);
    showError(`无法读取设置：${e.message ?? String(e)} 请关闭并重新打开此页面后重试。`);
    state('设置未读取，不能保存', 'error');
    return;
  }

  for (const field of controls) {
    field.addEventListener('input', () => {
      field.setCustomValidity('');
      field.removeAttribute('aria-invalid');
      state('有未保存的修改');
    });
  }

  // 页面沙箱不允许表单提交，保存必须通过明确的按钮点击触发。
  form.addEventListener('submit', event => event.preventDefault());
  let saving = false;
  const persist = async () => {
    if (saving) return;
    showError('');
    for (const field of controls) {
      field.setCustomValidity('');
      field.removeAttribute('aria-invalid');
    }
    const reject = (field, message) => {
      field.setCustomValidity(message);
      field.setAttribute('aria-invalid', 'true');
      field.reportValidity();
      state(message, 'error');
    };
    const appPath = fields.appPath.value.trim();
    if (!appPath.startsWith('/') || /[\r\n\0]/.test(appPath)) return reject(fields.appPath, '请填写 ChatGPT 应用的本机绝对路径。');
    const requestSeconds = Number(fields.requestTimeoutMs.value);
    const idleMinutes = Number(fields.idleTimeoutMs.value);
    if (!Number.isInteger(requestSeconds) || requestSeconds < 30 || requestSeconds > 600) return reject(fields.requestTimeoutMs, '单次请求应为 30–600 秒的整数。');
    if (!Number.isInteger(idleMinutes) || idleMinutes < 1 || idleMinutes > 30) return reject(fields.idleTimeoutMs, '连接空闲应为 1–30 分钟的整数。');
    const update = { appPath, chrome: fields.chrome.checked, requestTimeoutMs: requestSeconds * 1000, idleTimeoutMs: idleMinutes * 60_000 };
    saving = true;
    enable(false);
    state('正在保存…');
    try {
      // 合并前重新读取，避免覆盖其他页面刚保存的选项。
      const latest = await magpie.options.get();
      const previous = latest && typeof latest === 'object' && !Array.isArray(latest) ? { ...latest } : {};
      // 清除已停用的外部运行时选项，其余选项照常保留。
      delete previous.lcuPath;
      const result = await magpie.options.set({ ...previous, ...update });
      paint(result);
      state('设置已保存，重启 MCP 连接后生效', 'saved');
    } catch (e) {
      showError(`保存失败：${e.message ?? String(e)}`);
      state('设置未保存，请重试', 'error');
    } finally {
      saving = false;
      enable(true);
    }
  };
  save.addEventListener('click', persist);
  for (const field of controls) {
    if (field === fields.chrome) continue;
    field.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      if (!save.disabled) save.click();
    });
  }
}

const ready = typeof document !== 'undefined'
  ? mountPage({ document, magpie: globalThis.magpie })
  : undefined;
globalThis.MagpieComputerUsePage = Object.freeze({ DEFAULTS, mountPage, ready });
})();
