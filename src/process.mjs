import { spawn } from 'node:child_process';

export async function run(command, args = [], { cwd, env = process.env, signal, timeoutMs = 120000, inherit = false } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, signal, stdio: inherit ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const limit = 256 * 1024;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
    let forceTimer;
    child.once('spawn', () => { forceTimer = setTimeout(() => child.kill('SIGKILL'), timeoutMs + 10000); forceTimer.unref(); });
    child.stdout?.on('data', (data) => { if (stdout.length < limit) stdout += data.toString(); });
    child.stderr?.on('data', (data) => { if (stderr.length < limit) stderr += data.toString(); });
    child.once('error', (error) => { clearTimeout(timer); clearTimeout(forceTimer); reject(error); });
    child.once('close', (code, exitSignal) => {
      clearTimeout(timer); clearTimeout(forceTimer);
      if (code === 0 && !timedOut) resolve({ code, stdout, stderr });
      else reject(Object.assign(new Error(timedOut ? `${command} 超时。` : `${command} 退出：${code ?? exitSignal}\n${stderr.slice(-4000) || stdout.slice(-4000)}`), { code, stdout, stderr }));
    });
  });
}
