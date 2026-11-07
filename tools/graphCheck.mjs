// Will this workflow actually run on that server?
//   node tools/graphCheck.mjs workflows/wan22_i2v.json http://10.1.1.1:8188
//
// Reads the server's object_info and checks, for every node in the graph: that the class
// exists at all, that every input the graph feeds it is a real input of that class, and
// that every model file named by a loader is present in that loader's own option list.
// Wan graphs reference four or five large files by exact filename; a typo costs a queue
// slot and a cold model load to discover, and a missing custom node fails even later.
// Checking costs one HTTP request.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const file = process.argv[2];
const BASE = process.argv[3] || 'http://10.1.1.1:8188';
if (!file) {
  console.error('usage: node tools/graphCheck.mjs <workflow.json> [http://host:port]');
  process.exit(2);
}

// The owner's exported API graphs nest the payload under `graph` with a metadata block
// alongside it; a bare API export has the nodes at the top level.
const raw = JSON.parse(readFileSync(file, 'utf8'));
const graph = raw.graph && (raw.graph.class_type || Object.values(raw.graph).some(v => v && v.class_type))
  ? raw.graph
  : raw;

const res = await fetch(BASE + '/object_info');
if (!res.ok) { console.error(`object_info -> HTTP ${res.status}`); process.exit(1); }
const info = await res.json();

// Loaders and the input field that lists the files they can open.
const FILE_FIELDS = {
  UNETLoader: ['unet_name'],
  CheckpointLoaderSimple: ['ckpt_name'],
  VAELoader: ['vae_name'],
  CLIPLoader: ['clip_name'],
  LoraLoader: ['lora_name'],
  LoraLoaderModelOnly: ['lora_name'],
  ControlNetLoader: ['control_net_name'],
  UpscaleModelLoader: ['model_name'],
};

const problems = [];
const notes = [];
let nodes = 0;

for (const [id, node] of Object.entries(graph)) {
  if (!node || typeof node !== 'object' || !node.class_type) continue;   // metadata block
  nodes++;
  const def = info[node.class_type];
  if (!def) {
    problems.push(`${id} ${node.class_type}: the server does not have this node class`);
    continue;
  }
  const req = def.input?.required || {};
  const opt = def.input?.optional || {};
  const known = new Set([...Object.keys(req), ...Object.keys(opt)]);

  for (const [name, value] of Object.entries(node.inputs || {})) {
    // Autogrow and dynamic-combo widgets are exported flattened — ComfyMathExpression's
    // `values` template becomes `values.a` / `values.b`, SaveVideo's `format` becomes
    // `format.codec` — so a dotted name is valid when its prefix is a real input.
    const dot = name.indexOf('.');
    const base = dot < 0 ? name : name.slice(0, dot);
    if (!known.has(name) && !known.has(base)) {
      const near = [...known].filter(k => k.toLowerCase().includes(base.split('.')[0].toLowerCase()));
      problems.push(`${id} ${node.class_type}.${name}: not an input of this node` +
        (near.length ? ` (server offers: ${near.join(', ')})` : ''));
    }
    const fields = FILE_FIELDS[node.class_type];
    if (fields && fields.includes(name) && typeof value === 'string') {
      const choices = [].concat(req[name]?.[1] ?? req[name] ?? opt[name]?.[1] ?? []);
      // Combo widgets give a flat list of strings; some give a list of {content:...}
      // entries or nested groups, so only compare the ones that actually are filenames.
      const list = (Array.isArray(choices) ? choices : [])
        .map(c => (typeof c === 'string' ? c : c && typeof c.content === 'string' ? c.content : null))
        .filter(Boolean);
      if (list.length && !list.includes(value)) {
        const close = list.filter(c => c.toLowerCase().includes(value.toLowerCase().slice(0, 18)));
        problems.push(`${id} ${node.class_type}: "${value}" is not in this loader's files` +
          (close.length ? ` (closest: ${close.join(', ')})` : ''));
      }
    }
  }

  // Required inputs the graph never feeds nor sets.
  const supplied = Object.keys(node.inputs || {});
  for (const name of Object.keys(req)) {
    const given = supplied.includes(name) || supplied.some(s => s.startsWith(name + '.'));
    if (!given) {
      const spec = req[name];
      const hasDefault = Array.isArray(spec) && typeof spec[1] !== 'object';
      if (!hasDefault) problems.push(`${id} ${node.class_type}.${name}: required but the graph never supplies it`);
      else notes.push(`${id} ${node.class_type}.${name}: required, relies on the graph's own widget default`);
    }
  }
}

// Link sanity: every [nodeId, outputIndex] must point at a node in the graph.
for (const [id, node] of Object.entries(graph)) {
  if (!node || !node.class_type) continue;
  for (const [name, value] of Object.entries(node.inputs || {})) {
    if (Array.isArray(value) && typeof value[0] === 'string') {
      if (!graph[value[0]]) problems.push(`${id} ${node.class_type}.${name}: links to ${value[0]}, which is not in this graph`);
    }
  }
}

console.log(`graph ${file}   server ${BASE}`);
console.log(`nodes ${nodes}   classes checked against the server's own inventory`);
for (const n of notes.slice(0, 12)) console.log(`  note  ${n}`);
if (problems.length) {
  for (const p of problems) console.log(`  FAIL  ${p}`);
  console.log(`${problems.length} problem(s) — fix before queueing`);
  process.exit(1);
}
console.log('OK: every node class exists, every input name is real, every model file is on disk');
