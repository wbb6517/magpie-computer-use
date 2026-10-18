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
for (const dir of ['src', 'bin', 'page', 'scripts', 'tests', 'vendor']) candidates.push(...await files(path.join(root, dir)));
for (const file of candidates) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `Syntax check failed: ${file}`);
}
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
for (const file of [pkg.main, pkg.magpie.page.file, pkg.magpie.page.icon, 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) await fs.access(path.join(root, file));
const { default: plugin } = await import(path.join(root, 'index.mjs'));
if (plugin.id !== 'magpie-computer-use' || typeof plugin.server !== 'function') throw new Error('Missing magpie plugin lifecycle entry');
const page = spawnSync(process.execPath, ['scripts/check-page.mjs'], { cwd: root, encoding: 'utf8' });
if (page.status !== 0) throw new Error(page.stderr || page.stdout);
process.stdout.write(`Syntax and manifest checks passed (${candidates.length} modules).\n${page.stdout}`);
