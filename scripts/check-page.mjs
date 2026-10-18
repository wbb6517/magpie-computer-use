import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Run the asset the sandboxed page actually loads, as a classic script.
const source = await readFile(new URL('../page/app.js', import.meta.url), 'utf8');
const isolated = vm.createContext({});
vm.runInContext(source, isolated, { filename: 'page/app.js' });
const { mountPage, DEFAULTS } = isolated.MagpieComputerUsePage;

const html = await readFile(new URL('../page/index.html', import.meta.url), 'utf8');
const checks = [];
async function check(name, fn) {
  await fn();
  checks.push(name);
}

class Element {
  constructor() {
    this.value = ''; this.checked = false; this.hidden = false; this.disabled = false;
    this.textContent = ''; this.dataset = {}; this.handlers = new Map(); this.attributes = new Map();
  }
  addEventListener(name, fn) { this.handlers.set(name, fn); }
  async dispatch(name, data = {}) { return this.handlers.get(name)?.({ preventDefault() {}, ...data }); }
  async click() { return this.dispatch('click'); }
  setCustomValidity(message) { this.validityMessage = message; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  reportValidity() { this.reported = true; }
  focus() { this.focused = true; }
  select() { this.selected = true; }
}
function documentFixture() {
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const buttons = [];
  const document = {
    documentElement: { dataset: {}, style: { setProperty() {} } },
    getElementById(id) {
      assert(elements.has(id), `Element ${id} is present in page HTML`);
      return elements.get(id);
    },
    querySelectorAll(selector) { assert.equal(selector, '[data-copy]'); return buttons; },
  };
  return { document, elements, buttons };
}
function bridgeFixture(options = {}) {
  let current = options;
  const writes = [];
  const bridge = {
    ready: Promise.resolve({ dark: false, lang: 'zh-CN' }),
    onTheme(callback) { this.applyTheme = callback; },
    options: {
      async get() { return current; },
      async set(value) { writes.push(value); current = value; return value; },
    },
  };
  return { bridge, writes, changeOptions(value) { current = value; } };
}

await check('CSP-compatible page assets and accessible controls', () => {
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    assert.match(match[1], /\bsrc="[^"#]+"/);
    assert.equal(match[2].trim(), '', 'No inline JavaScript');
    assert.doesNotMatch(match[1], /https?:|\/\//);
  }
  assert.match(html, /src="_magpie\/bridge\.js"/);
  assert.match(html, /<script src="app\.js" defer><\/script>/);
  assert.doesNotMatch(html, /type="module"/);
  assert.match(html, /id="save-settings"[^>]*type="button"/);
  assert.doesNotMatch(source, /(^|\n)\s*(import|export)\s/m);
  for (const match of html.matchAll(/<label[^>]+for="([^"]+)"/g)) assert(html.includes(`id="${match[1]}"`));
  assert.match(html, /不能检测实时连接状态/);
});

await check('Extension setup uses the magpie resource library without user shell commands', () => {
  assert.match(html, /MCP 会自动登记到资源库/);
  assert.match(html, /资源库 → MCP 服务器/);
  assert.doesNotMatch(html, /command-config|command-register|在终端完成接入|支持 stdio MCP/);
  assert.match(html, /客户端不支持授权询问时，网关会取消该次应用授权/);
});

await check('The shipped classic script boots with only document and magpie globals', async () => {
  const { document, elements } = documentFixture();
  const { bridge } = bridgeFixture();
  const context = vm.createContext({ document, magpie: bridge, navigator: {} });
  vm.runInContext(source, context, { filename: 'page/app.js' });
  await context.MagpieComputerUsePage.ready;
  assert.equal(elements.get('save-state').textContent, '设置已读取');
  assert.equal(elements.get('save-settings').disabled, false);
});

await check('Default settings and magpie theme are loaded', async () => {
  const { document, elements } = documentFixture();
  const { bridge } = bridgeFixture();
  await mountPage({ document, magpie: bridge });
  assert.equal(elements.get('app-path').value, DEFAULTS.appPath);
  assert.equal(elements.has('lcu-path'), false);
  assert.equal('lcuPath' in DEFAULTS, false);
  assert.equal(elements.get('chrome').checked, false);
  assert.equal(elements.get('request-timeout').value, '120');
  assert.equal(elements.get('idle-timeout').value, '5');
  assert.equal(elements.get('save-settings').disabled, false);
  bridge.applyTheme({ dark: true, lang: 'zh-CN' });
  assert.equal(document.documentElement.dataset.theme, 'dark');
});

await check('Save merges latest options and converts displayed units', async () => {
  const { document, elements } = documentFixture();
  const fixture = bridgeFixture({ extension: { keep: true }, lcuPath: '/legacy/bin/lcu' });
  await mountPage({ document, magpie: fixture.bridge });
  fixture.changeOptions({ extension: { keep: true }, newlyAdded: 42, lcuPath: '/legacy/bin/lcu' });
  elements.get('request-timeout').value = '60';
  elements.get('idle-timeout').value = '2';
  elements.get('chrome').checked = true;
  await elements.get('save-settings').click();
  assert.equal(fixture.writes.length, 1);
  assert.deepEqual(fixture.writes[0].extension, { keep: true });
  assert.equal(fixture.writes[0].newlyAdded, 42);
  assert.equal('lcuPath' in fixture.writes[0], false, 'Legacy external LCU path is removed when saving');
  assert.equal(fixture.writes[0].requestTimeoutMs, 60_000);
  assert.equal(fixture.writes[0].idleTimeoutMs, 120_000);
  assert.equal(fixture.writes[0].chrome, true);
  assert.equal(elements.get('save-state').dataset.state, 'saved');
});

await check('Saving uses button clicks without submitting the sandboxed form', async () => {
  const { document, elements } = documentFixture();
  const fixture = bridgeFixture();
  await mountPage({ document, magpie: fixture.bridge });
  await elements.get('settings-form').dispatch('submit');
  assert.equal(fixture.writes.length, 0, 'Form submission never performs a save');
  await elements.get('save-settings').click();
  assert.equal(fixture.writes.length, 1);
  assert.equal(elements.get('save-state').dataset.state, 'saved');
});

await check('Invalid timeout and relative paths cannot be saved', async () => {
  const { document, elements } = documentFixture();
  const fixture = bridgeFixture();
  await mountPage({ document, magpie: fixture.bridge });
  for (const value of ['', '29', '601', '30.5', 'NaN']) {
    elements.get('request-timeout').value = value;
    await elements.get('save-settings').click();
    assert.equal(fixture.writes.length, 0);
    assert.equal(elements.get('request-timeout').attributes.get('aria-invalid'), 'true');
  }
  elements.get('request-timeout').value = '120';
  elements.get('idle-timeout').value = '31';
  await elements.get('save-settings').click();
  assert.equal(fixture.writes.length, 0);
  elements.get('idle-timeout').value = '5';
  elements.get('app-path').value = 'Applications/ChatGPT.app';
  await elements.get('save-settings').click();
  assert.equal(fixture.writes.length, 0);
  assert.equal(elements.get('app-path').attributes.get('aria-invalid'), 'true');
});

await check('Bridge/save failures never show saved or running status', async () => {
  const { document, elements } = documentFixture();
  const fixture = bridgeFixture();
  fixture.bridge.options.set = async () => { throw new Error('read-only settings'); };
  await mountPage({ document, magpie: fixture.bridge });
  await elements.get('save-settings').click();
  assert.equal(elements.get('save-state').dataset.state, 'error');
  assert.match(elements.get('page-error').textContent, /read-only settings/);
  assert.equal(elements.get('save-settings').disabled, false);
  const unavailable = documentFixture();
  await mountPage({ document: unavailable.document, magpie: null });
  assert.equal(unavailable.elements.get('save-settings').disabled, true);
  assert.match(unavailable.elements.get('save-state').textContent, /不能保存/);
});

console.log(`Page checks passed (${checks.length}):\n${checks.map(name => `  ✓ ${name}`).join('\n')}`);
