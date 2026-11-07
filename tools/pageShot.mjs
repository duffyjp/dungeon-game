// Renders one of the in-repo QA pages to a PNG with headless Chromium.
//   node tools/pageShot.mjs <page.html> <out.png> [width] [height] [urlQuery]
// Starts its own Vite server, so it works even when `npm run dev` is not running.
//   node tools/pageShot.mjs keycheck.html keycheck.png 1150 1700
//   node tools/pageShot.mjs seamcheck.html seamcheck.png 1620 1400
//   node tools/pageShot.mjs index.html depth9.png 1280 720 "?demo=1&seed=alpha&depth=9&preview=orc&tier=4"
//
// The browser is spawned without inherited pipes (Chromium on Windows keeps them open
// and hangs the caller) and we poll for the PNG it writes, then kill it.
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const [page, out, w = '1150', h = '1500', query = ''] = process.argv.slice(2);
if (!page || !out) {
  console.error('usage: node tools/pageShot.mjs <page.html> <out.png> [width] [height] [urlQuery]');
  process.exit(2);
}
const browser = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].find(existsSync);
if (!browser) { console.error('no Chromium browser found'); process.exit(2); }

const PORT = Number(process.env.SHOT_PORT || 5182);
// A full URL means "photograph what is already running" — useful for checking the dev server
// the human is actually looking at, rather than a fresh one this tool starts and tears down.
const remote = /^https?:\/\//.test(page);
let server = null;
let port = PORT;
if (!remote) {
  // Do not insist on a fixed port: when two QA runs overlap, strictPort makes the second one
  // die with an obscure exit code 1 while the first keeps the port, and the failure looks
  // like the page timed out. Take the next free port and report which one was used.
  server = await createServer({ logLevel: 'warn', server: { port: PORT, strictPort: false, watch: null } });
  await server.listen();
  port = server.httpServer?.address()?.port || PORT;
}
const targetUrl = remote ? `${page}${query}` : `http://localhost:${port}/${page}${query}`;

const target = join(process.cwd(), out);
rmSync(target, { force: true });                 // a stale file must not read as success
const profile = mkdtempSync(join(tmpdir(), 'strata-shot-'));

// Virtual-time budget: the game page preloads 88 textures, and 60 s of simulated time is
// not always enough for that plus a level build, which shows up as an intermittent
// "no screenshot produced". SHOT_BUDGET= lets a caller raise it per page.
const budget = Number(process.env.SHOT_BUDGET || 60000);
const child = spawn(browser, [
  `--user-data-dir=${profile}`, '--headless', '--disable-gpu', '--no-first-run',
  '--no-default-browser-check', `--window-size=${w},${h}`, `--virtual-time-budget=${budget}`,
  `--screenshot=${target}`, targetUrl
], { stdio: 'ignore', windowsHide: true });

// Two different clocks, deliberately separate knobs. SHOT_BUDGET is how much *page* time the
// browser simulates; SHOT_WAIT_MS is how long we wait in wall clock for the file to appear.
// Conflating them produced bad advice: the game now carries normal and roughness maps, and in
// software GL every simulated frame costs much more real CPU time, so raising the page-time
// budget made the wait longer without ever producing a shot.
const waitMs = Number(process.env.SHOT_WAIT_MS || Math.max(150000, budget * 3));
const deadline = Date.now() + waitMs;
while (Date.now() < deadline && !existsSync(target)) {
  await new Promise(r => setTimeout(r, 500));
}
const ok = existsSync(target);
try { child.kill('SIGKILL'); } catch { /* already gone */ }
if (server) await server.close();

const waitSeconds = waitMs / 1000;
console.log(ok ? `wrote ${out} (${Math.round(statSync(target).size / 1024)} KB)`
  : `no screenshot produced: ${targetUrl} did not settle within ${waitSeconds}s of wall clock while simulating ` +
    `${budget}ms of page time. In software GL each frame costs real CPU time — try lowering SHOT_BUDGET and raising SHOT_WAIT_MS.`);
process.exit(ok ? 0 : 1);
