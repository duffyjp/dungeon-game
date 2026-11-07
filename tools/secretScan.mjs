// What a public repo should not contain: credentials, private network details, machine paths
// that identify their owner. Scans the tracked file list, not the working tree, so it checks
// exactly what strangers can read.
//
//   node tools/secretScan.mjs
//
// Not a security product - a cheap sweep that catches the embarrassing case: a token committed
// while the repo was private and left there after it turned public.
import { execFileSync } from 'node:child_process';
import fs from 'fs';

const ROOT = process.cwd();
const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);

// Each rule says what it is, so a hit can be judged without reading the regex.
const RULES = [
  ['api key', /\bapi[_-]?key\b\s*[:=]\s*['"`]?[A-Za-z0-9_\-]{12,}/i],
  ['generic secret', /\b(secret|passwd|password)\b\s*[:=]\s*['"`]?[^\s'"`]{8,}/i],
  ['bearer token', /\bBearer\s+[A-Za-z0-9._\-]{16,}/],
  ['provider key shape', /\b(sk|ghp|gho|github_pat|xox[baprs]-|AKIA)[A-Za-z0-9_\-]{10,}\b/],
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['windows home path', /[A-Za-z]:\\\\Users\\\\(?!Public)/],
  ['unix home path', /\/home\/(?!runner)[a-z0-9_.-]+\/\./i],
  ['private ipv4', /\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/],
];

const SKIP_EXT = /\.(png|webp|jpg|jpeg|gif|mp3|ogg|wav|glb)$/i;
const hits = [];
let scanned = 0;

for (const f of files) {
  if (SKIP_EXT.test(f)) continue;
  let text;
  try { text = fs.readFileSync(`${ROOT}/${f}`, 'utf8'); } catch (e) { continue; }
  if (text.length > 600000) continue;
  scanned++;
  text.split(/\r?\n/).forEach((line, i) => {
    for (const [what, re] of RULES) {
      if (re.test(line)) hits.push(`${what}  ${f}:${i + 1}  ${line.trim().slice(0, 100)}`);
    }
  });
}

console.log(`secret scan: ${scanned} tracked text files (${files.length} total), ${hits.length} candidate findings`);
for (const h of hits.slice(0, 40)) console.log('  ' + h);
if (hits.length > 40) console.log(`  … ${hits.length - 40} more`);
// Findings are reported, not fatal: a private-network address in a documented art pipeline is a
// judgement call, a GitHub token is not. Exit 0 so this can run in CI without blocking a deploy
// on a judgement call; grep the output instead.
process.exit(0);
