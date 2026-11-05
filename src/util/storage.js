// localStorage-backed settings and best-run table. Fails soft when storage is
// unavailable (private mode, file://, etc.).

const SETTINGS_KEY = 'strata.settings';
const RUNS_KEY = 'strata.runs';

export function loadSettings(defaults) {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...defaults, ...JSON.parse(raw) } : defaults;
  } catch { return { ...defaults }; }
}

export function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

export function saveRun(run) {
  try {
    const runs = JSON.parse(localStorage.getItem(RUNS_KEY) || '[]');
    runs.push({ ...run, at: Date.now() });
    runs.sort((a, b) => b.score - a.score);
    localStorage.setItem(RUNS_KEY, JSON.stringify(runs.slice(0, 5)));
  } catch { /* ignore */ }
}

export function bestRuns() {
  try { return JSON.parse(localStorage.getItem(RUNS_KEY) || '[]'); } catch { return []; }
}
