// Runs the in-browser integration self-test (src/selftest.js) headlessly.
//   node tools/runSelfTest.mjs [--shot <file.png>]
// Starts a throwaway Vite server that exposes a POST /__selftest endpoint, launches
// headless Edge/Chrome against it, and waits for the page to report its verdict.
// Reporting over HTTP is deliberate: on Windows Chromium re-execs and keeps inherited
// pipes open, so scraping stdout/stderr or using --dump-dom hangs.
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
];
const browser = BROWSERS.find(existsSync);
if (!browser) {
  console.error('No Chromium browser found. Open the game with ?selftest=1 and read the panel instead.');
  process.exit(2);
}

const shotAt = process.argv.indexOf('--shot');
const shot = shotAt >= 0 ? process.argv[shotAt + 1] : null;

let resolveReport;
const reported = new Promise(res => { resolveReport = res; });

const server = await createServer({
  logLevel: 'warn',
  server: { port: 5181, strictPort: true, watch: null },
  plugins: [{
    name: 'selftest-report',
    configureServer(s) {
      s.middlewares.use('/__selftest', (req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('recorded');
          try {
            resolveReport(JSON.parse(body));
          } catch {
            resolveReport({ pass: 0, fail: 1, results: ['FAIL :: harness could not parse the report'] });
          }
        });
      });
    }
  }]
});
await server.listen();

const profile = mkdtempSync(join(tmpdir(), 'strata-selftest-'));
// The suite now decodes several animated WebPs frame by frame, which is real work the
// virtual-time clock does not fast-forward through. A hard-coded 25 s made the run fail
// intermittently with "the page never reported" — the wrong diagnosis and expensive to chase
// — so the budget is generous and overridable with SELFTEST_BUDGET=.
const budget = Number(process.env.SELFTEST_BUDGET || 60000);
const flags = [
  `--user-data-dir=${profile}`, '--headless', '--disable-gpu', '--no-first-run',
  '--no-default-browser-check', '--window-size=1100,900', `--virtual-time-budget=${budget}`
];
if (shot) flags.push(`--screenshot=${shot}`);
// Extra query fragments (e.g. "&at=stair") are appended so debug placements and other
// URL switches can be exercised through the same reporting path as the checks.
const extra = process.argv.slice(2).filter(a => a.startsWith('&')).join('');
flags.push(`http://localhost:5181/?selftest=1${extra}`);

const child = spawn(browser, flags, { stdio: 'ignore', detached: false, windowsHide: true });

const timeout = setTimeout(() => resolveReport({
  pass: 0, fail: 1,
  results: ['FAIL :: the browser never reported (did the page boot? is a stale browser holding the profile?)']
}), 90000);

const report = await reported;
clearTimeout(timeout);
try { child.kill('SIGKILL'); } catch { /* already gone */ }
await server.close();

for (const r of report.results || []) console.log(r);
console.log(`SUMMARY ${report.pass} passed / ${report.fail} failed`);
if (shot) console.log(`screenshot: ${shot}`);
process.exit(report.fail ? 1 : 0);
