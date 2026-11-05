// Chroma-key QA for every generated sprite (drives keycheck.html).
//   node tools/keyCheck.mjs
// Starts its own Vite server (so it never reads a stale module graph), runs headless
// Chromium, and waits for the page to POST its verdict to /__keycheck. Exit code is
// non-zero if anything keys badly, so it can gate a build.
//
// The HTTP report is deliberate: on Windows Chromium is a GUI-subsystem binary that
// either keeps inherited pipes open (hanging the caller) or returns before the page has
// run, so scraping its console is unreliable.
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const browser = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].find(existsSync);
if (!browser) { console.error('no Chromium browser found'); process.exit(2); }

let resolveReport;
const reported = new Promise(res => { resolveReport = res; });

const PORT = 5183;
const server = await createServer({
  logLevel: 'warn',
  server: { port: PORT, strictPort: true, watch: null },
  plugins: [{
    name: 'keycheck-report',
    configureServer(s) {
      s.middlewares.use('/__keycheck', (req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('recorded');
          try { resolveReport(JSON.parse(body)); }
          catch { resolveReport({ total: 0, ok: 0, bad: [{ key: '(harness)', verdict: 'unparsable report' }] }); }
        });
      });
    }
  }]
});
await server.listen();

const profile = mkdtempSync(join(tmpdir(), 'strata-keycheck-'));
const child = spawn(browser, [
  `--user-data-dir=${profile}`, '--headless', '--disable-gpu', '--no-first-run',
  '--no-default-browser-check', '--window-size=1150,900', '--virtual-time-budget=200000',
  `http://localhost:${PORT}/keycheck.html`
], { stdio: 'ignore', windowsHide: true });

const timer = setTimeout(() => resolveReport({
  total: 0, ok: 0, bad: [{ key: '(browser)', verdict: 'never reported — did the page boot?' }]
}), 150000);

const report = await reported;
clearTimeout(timer);
try { child.kill('SIGKILL'); } catch { /* already gone */ }
await server.close();

console.log(`keyed assets: ${report.total}   clean: ${report.ok}`);
for (const b of report.bad || []) {
  console.log(`  ${b.key}  ${b.verdict}${b.magentaLeft !== undefined ? `  magentaLeft=${b.magentaLeft}%  eaten=${b.eaten}%` : ''}`);
}
const bad = (report.bad || []).length;
console.log(bad
  ? `\n${bad} asset(s) key badly. Either regenerate with a flatter backdrop (spec §13.5) or retune the thresholds in src/render/chromaKey.js — keycheck.html shows each one measured.`
  : '\nall keyed assets pass');
process.exit(bad || !report.total ? 1 : 0);
