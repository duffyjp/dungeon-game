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

const PORT = 5182;
const server = await createServer({ logLevel: 'warn', server: { port: PORT, strictPort: true, watch: null } });
await server.listen();

const target = join(process.cwd(), out);
rmSync(target, { force: true });                 // a stale file must not read as success
const profile = mkdtempSync(join(tmpdir(), 'strata-shot-'));

const child = spawn(browser, [
  `--user-data-dir=${profile}`, '--headless', '--disable-gpu', '--no-first-run',
  '--no-default-browser-check', `--window-size=${w},${h}`, '--virtual-time-budget=60000',
  `--screenshot=${target}`, `http://localhost:${PORT}/${page}${query}`
], { stdio: 'ignore', windowsHide: true });

const deadline = Date.now() + 150000;
while (Date.now() < deadline && !existsSync(target)) {
  await new Promise(r => setTimeout(r, 500));
}
const ok = existsSync(target);
try { child.kill('SIGKILL'); } catch { /* already gone */ }
await server.close();

console.log(ok ? `wrote ${out} (${Math.round(statSync(target).size / 1024)} KB)`
  : 'no screenshot produced (page did not finish within 150 s)');
process.exit(ok ? 0 : 1);
