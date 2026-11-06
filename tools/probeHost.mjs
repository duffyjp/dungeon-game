// Which port is this machine actually serving on?
//   node tools/probeHost.mjs 10.1.1.1
//   node tools/probeHost.mjs 10.1.1.1 8000 8188
//
// A ComfyUI box that is "up" can still be unreachable for the most boring reasons: it listens
// on a non-default port, it is bound to 127.0.0.1 only (ComfyUI's default, which means no
// network access at all until it is started with --listen), or it is behind TLS. This
// separates those cases: first a TCP connect sweep, then an HTTP and HTTPS probe of anything
// open, so the answer is "port 8188 is open but returns nothing on /system_stats" rather
// than a shrug.
import net from 'node:net';

const [host, ...explicit] = process.argv.slice(2);
if (!host) { console.error('usage: node tools/probeHost.mjs <host> [port ...]'); process.exit(2); }

// Accept plain ports and ranges: node tools/probeHost.mjs 10.1.1.1 1-20000
const PORTS = explicit.length
  ? explicit.flatMap(a => {
      const m = /^(\d+)-(\d+)$/.exec(a);
      if (m) return Array.from({ length: Number(m[2]) - Number(m[1]) + 1 }, (_, i) => Number(m[1]) + i);
      return [Number(a)];
    }).filter(Number.isFinite)
  : [22, 80, 443, 445, 1143, 3000, 3389, 5000, 5900, 7681, 7860, 7861, 8000, 8001, 8008, 8010,
    8042, 8080, 8081, 8090, 8123, 8181, 8187, 8188, 8189, 8190, 8199, 8200, 8501, 8642, 8787,
    8888, 9000, 9090, 10000, 11434, 12345, 27017, 50000];

const CONN_TIMEOUT = Number(process.env.PROBE_TIMEOUT || 2500);

function tcpOpen(port) {
  return new Promise(resolve => {
    const s = net.connect({ host, port });
    const done = ok => { try { s.destroy(); } catch { /* already */ } resolve(ok); };
    s.setTimeout(CONN_TIMEOUT);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

async function httpProbe(port, tls) {
  const url = `${tls ? 'https' : 'http'}://${host}:${port}/system_stats`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, tls: { rejectUnauthorized: false } });
    const j = await res.json().catch(() => null);
    if (j?.system?.comfyui_version) {
      const dev = (j.devices || []).map(d => `${d.name} ${((d.vram_total || 0) / 1024 ** 3).toFixed(1)} GB (${((d.vram_free || 0) / 1024 ** 3).toFixed(1)} free)`).join('; ');
      return `ComfyUI ${j.system.comfyui_version} — ${dev}`;
    }
    return `HTTP ${res.status}, not ComfyUI`;
  } catch (e) {
    return tls ? 'TLS handshake failed' : `HTTP: ${String(e.message).slice(0, 60)}`;
  } finally {
    clearTimeout(t);
  }
}

console.log(`TCP sweep of ${host} across ${PORTS.length} ports`);
const open = [];
for (let i = 0; i < PORTS.length; i += 128) {
  const chunk = await Promise.all(PORTS.slice(i, i + 128).map(async p => ({ p, up: await tcpOpen(p) })));
  for (const c of chunk) if (c.up) { open.push(c.p); console.log(`  open: ${c.p}`); }
}

if (!open.length) {
  console.log('nothing answered a TCP connect on this list.');
  console.log('If the port you expect is not in this list, pass it: node tools/probeHost.mjs ' + host + ' <port>');
  console.log('If it is in the list and still silent, the service is almost certainly bound to');
  console.log('127.0.0.1 — ComfyUI does that unless started with --listen (or --host 0.0.0.0).');
  process.exit(1);
}

for (const p of open) {
  const plain = await httpProbe(p, false);
  const secure = await httpProbe(p, true);
  console.log(`  ${p}: http -> ${plain} | https -> ${secure}`);
}
