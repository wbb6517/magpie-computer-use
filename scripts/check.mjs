import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function files(dir) {
  const out = [];
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    const target = path.join(dir, item.name);
    if (item.isDirectory()) out.push(...await files(target));
    else if (item.name.endsWith('.mjs')) out.push(target);
  }
  return out;
}
const candidates = [path.join(root, 'index.mjs')];
for (const dir of ['src', 'bin', 'scripts', 'tests', 'vendor']) candidates.push(...await files(path.join(root, dir)));
for (const file of candidates) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `Syntax check failed: ${file}`);
}
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
for (const file of [pkg.main, 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) await fs.access(path.join(root, file));
const { VERSION } = await import(path.join(root, 'src/config.mjs'));
if (pkg.version !== VERSION) throw new Error('Package and MCP versions must match');
const { default: plugin } = await import(path.join(root, 'index.mjs'));
if (plugin.id !== 'magpie-computer-use' || typeof plugin.server !== 'function') throw new Error('Missing magpie plugin lifecycle entry');
if (pkg.magpie?.page) throw new Error('Zero-configuration extension must not declare a settings page');
if (pkg.magpie?.kind !== 'tools') throw new Error('Computer Use must declare the tools plugin kind');
const icon = await fs.readFile(path.join(root, 'assets/icon.svg'));
if (pkg.magpie?.icon !== `data:image/svg+xml;base64,${icon.toString('base64')}` || icon.length > 1024 * 1024) throw new Error('Plugin icon must match the bundled SVG and stay below 1 MB');
if (!pkg.files.includes('assets')) throw new Error('Plugin assets must be included in the package');
process.stdout.write(`Syntax, lifecycle and zero-configuration manifest checks passed (${candidates.length} modules).\n`);
