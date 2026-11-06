// What can this ComfyUI box actually run?
//   node tools/comfyStats.mjs [http://10.0.0.99:8000]
//
// Reads the server's own inventory rather than guessing: GPU, VRAM, versions, and the model
// files loaded by each kind of loader node. Model recommendations are only worth making
// against hardware that exists, and the answer to "why can't we just use <model>" is very
// often "because there is 12 GB on that card and that checkpoint needs 24".
const BASE = process.argv[2] || 'http://10.0.0.99:8000';

async function get(pathname) {
  const res = await fetch(BASE + pathname);
  if (!res.ok) throw new Error(`${pathname} -> HTTP ${res.status}`);
  return res.json();
}

const stats = await get('/system_stats');
console.log(`server ${BASE}`);
console.log(`comfyui ${stats.system.comfyui_version}   torch ${stats.system.torch_version}   cuda ${stats.system.cuda_version}`);
for (const d of stats.devices || []) {
  const gb = n => (n / 1024 ** 3).toFixed(1);
  console.log(`device ${d.name}: ${gb(d.vram_total)} GB total, ${gb(d.vram_free)} GB free` +
    (d.comfy_region ? ` (memory region: ${d.comfy_region})` : ''));
}

// Each loader lists its available files in the widget's option array.
const LOADERS = {
  CheckpointLoaderSimple: 'ckpt_name',
  UnetLoader: 'unet_name',
  UNetLoader: 'unet_name',
  VAELoader: 'vae_name',
  CLIPLoader: 'clip_name',
  LoraLoader: 'lora_name',
  UpscaleModelLoader: 'model_name',
  ControlNetLoader: 'control_net_name',
  ImageOnlyCheckpointLoader: 'ckpt_name',
  IPAdapterUnifiedLoader: 'preset'
};

for (const [node, field] of Object.entries(LOADERS)) {
  try {
    const info = await get(`/object_info/${node}`);
    const entry = info[node];
    if (!entry) { console.log(`${node}: not present on this server`); continue; }
    const opts = entry.input?.required?.[field]?.[0] ?? entry.input?.required?.[field];
    const list = Array.isArray(opts) ? opts : [];
    console.log(`${node} (${field}): ${list.length ? list.join(', ') : 'none installed'}`);
  } catch (e) {
    console.log(`${node}: ${e.message}`);
  }
}
