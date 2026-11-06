// Does the built game work the way GitHub Pages will serve it?
//   npm run build && node tools/checkBuild.mjs
//
// This deliberately does NOT use the Vite dev server. It serves dist/ as plain static
// files from Node's own http server — the closest local stand-in for a static host — then
// runs the in-browser integration self-test against it with every generated image loaded.
// Anything that only works because a dev server papered over it shows up here instead:
// absolute asset paths that 404 under /<user>/<repo>/, images the build forgot to copy,
// or a bundle that is too heavy for a browser to fetch.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve('dist');
const PORT = 4181;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.wasm': 'application/wasm',
  '.ico': 'image/x-icon'
};

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

if (!existsSync(join(ROOT, 'index.html'))) {
  console.error('dist/index.html is missing — run `npm run build` first.');
  process.exit(2);
}

// ---------------------------------------------------------------- static file server
let reportResolve;
const reported = new Promise(r => { reportResolve = r; });

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/__selftest') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('recorded');
      try { reportResolve(JSON.parse(body)); }
      catch { reportResolve({ pass: 0, fail: 1, results: ['FAIL :: harness could not parse the report'] }); }
    });
    return;
  }

  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = join(ROOT, url);
  // A static host hands out files inside the site and nothing else. Same rule here.
  if (file !== ROOT && !file.startsWith(ROOT + sep)) { res.writeHead(403).end('outside the site'); return; }
  const target = url.endsWith('/') ? join(file, 'index.html') : file;
  if (!existsSync(target) || !statSync(target).isFile()) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(target).toLowerCase()] || 'application/octet-stream' });
  res.end(readFileSync(target));
});

await new Promise(r => server.listen(PORT, r));

// ---------------------------------------------------------------- static sanity checks
const problems = [];
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
// The build must not hard-code the domain root: on a project page the site lives under
// /<user>/<repo>/ and a leading slash points at the wrong place.
if (/(src|href)="\//.test(html)) problems.push('index.html references an absolute path (src="/..." or href="/...")');
if (!existsSync(join(ROOT, '.nojekyll'))) problems.push('dist/.nojekyll missing — Jekyll would process the site');
if (!existsSync(join(ROOT, 'music/manifest.json'))) problems.push('dist/music/manifest.json missing — music pinning would 404 when hosted');

const files = walk(ROOT);
const total = files.reduce((s, f) => s + statSync(f).size, 0);
const biggest = files.map(f => ({ f, size: statSync(f).size })).sort((a, b) => b.size - a.size)[0];
if (biggest.size > 90 * 1024 * 1024) problems.push(`largest file is ${(biggest.size / 1048576).toFixed(1)} MB — over the per-file limit`);

console.log(`${files.length} files, ${(total / 1048576).toFixed(1)} MB served from dist/ on http://localhost:${PORT}`);
console.log(`largest: ${biggest.f.replace(ROOT + sep, '')} (${(biggest.size / 1048576).toFixed(2)} MB)`);
for (const p of problems) console.log('STATIC CHECK FAILED :: ' + p);

// ---------------------------------------------------------------- the real page, in a browser
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
];
const browser = BROWSERS.find(existsSync);
if (!browser) {
  console.error('no Chromium browser found — the static checks passed, but the page itself was not run.');
  server.close();
  process.exit(problems.length ? 1 : 0);
}

const profile = mkdtempSync(join(tmpdir(), 'strata-buildcheck-'));
const budget = Number(process.env.BUILDCHECK_BUDGET || 220000);
const child = spawn(browser, [
  `--user-data-dir=${profile}`, '--headless', '--disable-gpu', '--no-first-run',
  '--no-default-browser-check', '--window-size=1100,900', `--virtual-time-budget=${budget}`,
  // &assets=1 forces every generated image to be fetched and decoded, which is what a
  // visitor's first load actually does.
  `http://localhost:${PORT}/?selftest=1&assets=1`
], { stdio: 'ignore', windowsHide: true });

const timer = setTimeout(() => reportResolve({
  pass: 0, fail: 1,
  results: ['FAIL :: the browser never reported (page did not boot from static files?)']
}), 150000);

const report = await reported;
clearTimeout(timer);
try { child.kill('SIGKILL'); } catch { /* already gone */ }
server.close();

const fails = (report.results || []).filter(r => r.startsWith('FAIL'));
for (const r of fails) console.log(r);
console.log(`SELF-TEST on the built site: ${report.pass} passed / ${report.fail} failed`);

const ok = report.fail === 0 && problems.length === 0;
console.log(ok ? 'BUILD CHECK PASSED — dist/ is ready for a static host'
  : 'BUILD CHECK FAILED — see the lines above');
process.exit(ok ? 0 : 1);
