// Find ComfyUI servers on the LAN.
//   node tools/findComfy.mjs                 # probe the known subnets on the common ports
//   node tools/findComfy.mjs 10.1.1.5 10.0.0.7
//
// Useful because the MCP integration points at one fixed host, and a second machine is only
// interesting once you know what it is: same API, different GPU, different installed models.
// Every hit is reported with the hardware it reports, so the answer to "can that box do the
// job" arrives with the answer to "can we reach it".
import { networkInterfaces } from 'node:os';

const PORTS = (process.env.COMFY_PORTS || '8000,8188,8189,8001').split(',').map(Number);
const TIMEOUT = Number(process.env.COMFY_TIMEOUT || 1500);

function localSubnets() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address.split('.').slice(0, 3).join('.'));
    }
  }
  return [...new Set(out)];
}

const args = process.argv.slice(2);
const hosts = args.length
  ? args
  : localSubnets().flatMap(p => [1, ...Array.from({ length: 254 }, (_, i) => i + 1)]
      .filter(n => n > 0 && n < 255).map(n => `${p}.${n}`));

async function probe(host, port) {
  const url = `http://${host}:${port}/system_stats`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const j = await res.json();
    return { url, j };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

console.log(`probing ${hosts.length} hosts on ports ${PORTS.join(', ')}`);
const found = [];
const queue = [];
for (const h of hosts) for (const p of PORTS) {
  queue.push(probe(h, p).then(r => { if (r) { found.push(r); console.log(`FOUND ${r.url}`); } }));
  // Keep the socket count sane: burst in chunks rather than 1000 at once.
  if (queue.length >= 128) { await Promise.allSettled(queue.splice(0, queue.length)); }
}
await Promise.allSettled(queue);

if (!found.length) {
  console.log('no ComfyUI /system_stats responded. Is the machine on, and is its port open?');
  process.exit(1);
}

for (const { url, j } of found) {
  console.log(`\n${url}`);
  console.log(`  comfyui ${j.system?.comfyui_version}`);
  for (const d of j.devices || []) {
    const gb = n => (n / 1024 ** 3).toFixed(1);
    console.log(`  device ${d.name}: ${gb(d.vram_total)} GB total, ${gb(d.vram_free)} GB free`);
  }
}
console.log(`\n${found.length} server(s). Detail per server: node tools/comfyStats.mjs <url>`);
