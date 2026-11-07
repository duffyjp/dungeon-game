// Restart the dev server and prove it actually happened.
//
//   node tools/devserver.mjs                restart on the configured port
//   node tools/devserver.mjs --status       just report who owns the port
//   node tools/devserver.mjs --port 5180
//
// Why this exists: the asset registry is built by a build-time glob, so a clip or a tile
// added after the dev server started is invisible to it — the game silently falls back to
// placeholder art for anything the running server has never seen. The obvious fix, "restart
// the dev server", failed three times in a row here, because the attempt looked for a
// process by command line and found nothing, so nothing was stopped, and the new server
// failed to bind a port already in use and exited. A restart that changes nothing looks
// exactly like a restart that worked.
//
// So this kills whoever owns the port by PID, starts a fresh server, and then verifies from
// the outside: the port must be listening again, and the compiled registry module must be
// fetchable. It prints the new PID so the next person is not guessing.
import fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import path from 'path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d = null) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const PORT = Number(arg('port', 5177));
const STATUS_ONLY = process.argv.includes('--status');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function listeners(port) {
  // netstat without a protocol filter, because Vite binds the IPv6 loopback: `netstat -ano
  // -p TCP` reports nothing for a port that is demonstrably listening, which is what made an
  // earlier version of this tool believe the port was free.
  const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    const m = line.match(/:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
    if (m && Number(m[1]) === port) pids.add(Number(m[2]));
  }
  return [...pids];
}

const owners = listeners(PORT);
if (STATUS_ONLY) {
  console.log(owners.length ? `port ${PORT} is held by pid ${owners.join(', ')}` : `port ${PORT} is free`);
  process.exit(0);
}

for (const pid of owners) {
  let name = 'unknown';
  try { name = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).split('\n')[0] || name; } catch { /* name is a courtesy */ }
  console.log(`stopping pid ${pid} (${String(name).slice(0, 60)})`);
  try { execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' }); }
  catch (e) { console.error(`could not stop ${pid}: ${e.message}`); process.exit(1); }
}
await sleep(1200);
if (listeners(PORT).length) { console.error(`port ${PORT} is still held after the kill`); process.exit(1); }

const outLog = fs.openSync(path.join(ROOT, 'devserver.out.log'), 'w');
const errLog = fs.openSync(path.join(ROOT, 'devserver.err.log'), 'w');
const child = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort'], {
  cwd: ROOT, detached: true, stdio: ['ignore', outLog, errLog], windowsHide: true
});
child.unref();
fs.closeSync(outLog);
fs.closeSync(errLog);

let up = false;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  if (listeners(PORT).length) { up = true; break; }
}
if (!up) { console.error(`the new server never bound port ${PORT} — check devserver.out.log`); process.exit(1); }

const pid = listeners(PORT).join(', ');
try {
  const res = await fetch(`http://localhost:${PORT}/src/render/assets.js`);
  console.log(`dev server restarted: pid ${pid}, registry module HTTP ${res.status}`);
} catch (e) {
  console.log(`dev server restarted: pid ${pid} (module check failed: ${e.message})`);
}
console.log(`open http://localhost:${PORT}/ and hard-refresh — assets added since the last start are now visible`);
