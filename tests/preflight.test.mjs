import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PROJECT_ROOT } from '../src/config.mjs';

test('unsigned discovered runtime cannot execute its Node before trusted-launcher verification', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'magpie-preflight-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const app = path.join(temporary, 'Pretend.app');
  const resources = path.join(app, 'Contents/Resources');
  const runtime = path.join(resources, 'cua_node');
  const marker = path.join(temporary, 'untrusted-node-ran');
  const files = [
    'bin/node_repl', 'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs',
    'lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient',
    'lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/service.js',
    'lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/targets/mac/client.js',
  ];
  for (const file of files) { const target = path.join(runtime, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, '', { mode: 0o700 }); }
  await fs.writeFile(path.join(runtime, 'bin/node'), '#!/bin/sh\ntouch "' + marker + '"\nexit 0\n', { mode: 0o700 });
  await fs.writeFile(path.join(runtime, 'manifest.json'), JSON.stringify({ platform: 'darwin', arch: 'arm64', runtime_archive_version: 'pretend' }));
  await fs.writeFile(path.join(app, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.openai.codex</string></dict></plist>');
  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'bin/magpie-computer-use.mjs'), 'mcp', '--app', app], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  clearTimeout(timeout);
  assert.notEqual(code, 0);
  assert.match(stderr, /codesign failed/);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});
