// Run a saved ComfyUI graph on whichever box answers first — 5070 Ti, then the 2060.
//
//   node tools/comfyRun.mjs --graph workflows/qwen_image_edit.json \
//        --upload assets/images/vfx/ghost_trail.png --image-node 470 \
//        --set "459:500.prompt=Remove the background and leave full transparency" \
//        --set "459:484.on_false=Remove the background and leave full transparency" \
//        --set "459:458.seed=44200" --set "459:458.steps=25" \
//        --set "461.filename_prefix=strata-qwen" --out experiments/qwen
//
// Deliberately separate from the MCP integration: the MCP server is bound to one ComfyUI
// host and that is the right arrangement for z_image_turbo, which is a template with locked
// internals and a licence we ship on. This tool exists for the second box and the second
// model, where the graph is a reviewed file in workflows/ and the only patched nodes are the
// ones that file says may be patched. Outputs land in the folder you pass, never in
// assets/images, so nothing can ship from an experiment by accident.
import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import { analyzePng } from './pngAlpha.mjs';

const HOSTS = (process.env.COMFY_HOSTS || 'http://10.1.1.1:8188,http://10.0.0.99:8000').split(',');
const TIMEOUT_MS = Number(process.env.COMFY_RUN_TIMEOUT || 20 * 60 * 1000);

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : null;
}
function allArgs(name) {
  const out = [];
  process.argv.forEach((a, i) => { if (a === '--' + name) out.push(process.argv[i + 1]); });
  return out;
}

const graphPath = arg('graph');
if (!graphPath) {
  console.error('usage: node tools/comfyRun.mjs --graph <workflow.json> [--upload <file> --image-node <id>] [--set node.field=value ...] [--out <dir>]');
  process.exit(2);
}
const wrapped = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
// A template file may wrap the graph in metadata (model, licence, patch rules) so the rules
// live next to the graph instead of only in someone's memory.
const graph = wrapped.graph || wrapped;

// ---------------------------------------------------------------- pick a server
async function probe(host) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(host + '/system_stats', { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally { clearTimeout(t); }
}

let base = null, stats = null;
for (const h of HOSTS) {
  const s = await probe(h.trim());
  if (s) {
    base = h.trim(); stats = s;
    const d = (s.devices || [])[0];
    const gb = n => ((n || 0) / 1024 ** 3).toFixed(1);
    console.log(`server ${base} — comfyui ${s.system?.comfyui_version}, ${d?.name}, ${gb(d?.vram_free)} GB free of ${gb(d?.vram_total)}`);
    break;
  }
  console.log(`skipping ${h.trim()} — no answer`);
}
if (!base) { console.error('no ComfyUI server reachable on: ' + HOSTS.join(', ')); process.exit(1); }

// ---------------------------------------------------------------- upload inputs
for (const file of allArgs('upload')) {
  const buf = fs.readFileSync(file);
  const form = new FormData();
  form.append('image', new Blob([buf]), path.basename(file));
  form.append('type', 'input');
  form.append('overwrite', 'true');
  const res = await fetch(base + '/upload/image', { method: 'POST', body: form });
  if (!res.ok) { console.error(`upload failed: HTTP ${res.status} ${await res.text()}`); process.exit(1); }
  const info = await res.json();
  console.log(`uploaded ${path.basename(file)} -> ${info.name}${info.subfolder ? ' (' + info.subfolder + ')' : ''}`);
  const node = arg('image-node');
  if (node) {
    if (!graph[node]) { console.error(`--image-node ${node} is not in ${graphPath}`); process.exit(1); }
    graph[node].inputs.image = info.subfolder ? `${info.subfolder}/${info.name}` : info.name;
  }
}

// ---------------------------------------------------------------- patch nodes
const coerce = v => (v === 'true' ? true : v === 'false' ? false : (/^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v));
for (const pair of allArgs('set')) {
  const eq = pair.indexOf('=');
  const key = pair.slice(0, eq), value = pair.slice(eq + 1);
  const dot = key.lastIndexOf('.');
  const node = key.slice(0, dot), field = key.slice(dot + 1);
  if (!graph[node]) { console.error(`node ${node} not in graph`); process.exit(1); }
  graph[node].inputs[field] = coerce(value);
  console.log(`patched ${node}.${field} = ${field === 'prompt' ? value.slice(0, 70) + '…' : value}`);
}

// ---------------------------------------------------------------- submit and wait
const clientId = crypto.randomUUID();
const sent = await fetch(base + '/prompt', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ prompt: graph, client_id: clientId })
});
if (!sent.ok) {
  const body = await sent.text();
  console.error(`submit rejected: HTTP ${sent.status}\n${body.slice(0, 2000)}`);
  process.exit(1);
}
const submitted = await sent.json();
const promptId = submitted.prompt_id;
console.log(`queued as ${promptId}`);

const started = Date.now();
let entry = null;
while (!entry) {
  if (Date.now() - started > TIMEOUT_MS) { console.error(`timed out after ${TIMEOUT_MS / 1000}s — the job may still be running (check the server's queue)`); process.exit(1); }
  await new Promise(r => setTimeout(r, 2000));
  const h = await fetch(`${base}/history/${promptId}`).then(r => r.json()).catch(() => null);
  if (!h || !h[promptId]) continue;
  entry = h[promptId];
}

const status = entry.status || {};
if (status.status_str && status.status_str !== 'success') {
  console.error(`run reported ${status.status_str}`);
  for (const m of (status.messages || [])) console.error('  ' + JSON.stringify(m).slice(0, 500));
  process.exit(1);
}

// ---------------------------------------------------------------- fetch outputs
const outDir = arg('out') || 'experiments/comfy';
fs.mkdirSync(outDir, { recursive: true });

function pngInfo(buf) {
  // Colour type alone is not evidence of transparency, so measure the pixels instead.
  try {
    const r = analyzePng(buf);
    return { w: r.w, h: r.h, kind: `colour type ${r.colorType}`, clear: r.clear, soft: r.soft, opaque: r.opaque, softMean: r.softMean, verdict: r.verdict || r.unsupported };
  } catch (e) {
    return { note: `could not analyse (${e.message})` };
  }
}

const produced = [];
for (const out of Object.values(entry.outputs || {})) {
  for (const img of out.images || []) {
    const url = `${base}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || '')}&type=${img.type || 'output'}`;
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
    const to = path.join(outDir, img.filename);
    fs.writeFileSync(to, buf);
    const info = pngInfo(buf);
    produced.push({ file: to, bytes: buf.length, ...info });
  }
}

if (!produced.length) { console.log('the run finished but produced no images'); process.exit(1); }
for (const p of produced) {
  const line = p.verdict
    ? `${p.w}x${p.h}  clear ${p.clear}%  soft ${p.soft}% (${p.softMean})  opaque ${p.opaque}%  — ${p.verdict}`
    : `${p.w}x${p.h}  ${p.kind || ''} ${p.note || ''}`;
  console.log(`${p.file}\n  ${(p.bytes / 1024).toFixed(1)} KB  ${line}`);
}
// An all-clear image is not a successful cutout, it is a deleted subject, so the pass
// condition needs both halves of the frame present.
const anyReal = produced.some(p => (p.clear || 0) >= 15 && (p.opaque || 0) >= 12);
const castOf = mean => {
  const m = /\((\d+), (\d+), (\d+)\)/.exec(mean || '');
  if (!m) return null;
  const [r, g, b] = [+m[1], +m[2], +m[3]];
  return Math.min(r, b) - g;            // positive means magenta/violet in the edge band
};
const castTint = produced.find(p => (p.soft || 0) > 10 && castOf(p.softMean) > 20);
console.log(anyReal ? 'RESULT: at least one output has a genuinely transparent background'
  : 'RESULT: no output has both a clear background and an opaque subject, whatever the colour type says');
if (castTint) console.log(`NOTE: the soft edge band of ${castTint.file.split(/[\\/]/).pop()} carries a coloured fringe (${castTint.softMean}) — check it against the background of the image you fed in`);
console.log(`\nmodel: ${wrapped.model || 'unknown'}\nlicence: ${wrapped.licence || 'RECORD IT before this asset goes anywhere near assets/images/'}`);
