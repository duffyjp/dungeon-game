import { Game } from './main.js';
import { runSelfTest } from './selftest.js';

const params = new URLSearchParams(location.search);
const game = new Game();
window.__strata = game;

game.boot()
  .then(async () => {
    document.getElementById('loading')?.classList.add('done');
    if (params.get('selftest')) {
      const r = await runSelfTest(game);
      console.info(`SELFTEST ${r.pass} passed / ${r.fail} failed`);
    }
  })
  .catch(err => {
    const el = document.getElementById('loading');
    if (el) el.textContent = 'failed to start: ' + err.message;
    const pre = document.createElement('pre');
    pre.id = 'selftest-results';
    pre.textContent = `FAIL :: boot threw :: ${err.stack || err.message}`;
    document.body.appendChild(pre);
    document.title = 'SELFTEST BOOT FAILURE';
    console.error(err);
  });
