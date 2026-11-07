import { defineConfig } from 'vite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Relative base, not '/'. GitHub Pages serves a project site under /<user>/<repo>/, and
// absolute asset paths would then point at the domain root and 404. './' makes the built
// bundle work under any subpath, and also from a file:// double-click while testing.
export default defineConfig({
  base: './',

  plugins: [
    // The music manifest is optional and user-supplied, so it cannot be imported (a
    // missing import breaks the build). Copy it next to the site instead, and the loader
    // fetches it from the site root — which is the only way it can be found once hosted.
    {
      name: 'copy-music-manifest',
      writeBundle(options) {
        const from = path.join(HERE, 'assets/music/manifest.json');
        if (!fs.existsSync(from)) return;
        const outDir = options.dir || path.join(HERE, 'dist');
        const to = path.join(outDir, 'music');
        fs.mkdirSync(to, { recursive: true });
        fs.copyFileSync(from, path.join(to, 'manifest.json'));
        // The music credits ship with the build: the MiniMax-Music3 community licence requires
        // the model to be named in the product, and provenance that only lives in the repo is
        // not provenance for whoever plays the hosted game.
        const credits = path.join(HERE, 'assets/music/credits.json');
        if (fs.existsSync(credits)) fs.copyFileSync(credits, path.join(to, 'credits.json'));
      }
    },
    {
      // Animated sprite clips: copied as themselves rather than pulled through the asset
      // pipeline, so the path the engine asks for is the path that exists, and a clip built
      // after the dev server started is still reachable. See src/render/animation.js.
      name: 'copy-anim-clips',
      writeBundle(options) {
        const from = path.join(HERE, 'assets/anim');
        if (!fs.existsSync(from)) return;
        const outDir = options.dir || path.join(HERE, 'dist');
        const to = path.join(outDir, 'anim');
        fs.mkdirSync(to, { recursive: true });
        for (const f of fs.readdirSync(from)) fs.copyFileSync(path.join(from, f), path.join(to, f));
      }
    }
  ],

  server: {
    port: 5177,
    strictPort: true,
    // Watching stays on for source so edits hot-reload, but two things reliably crash
    // chokidar on Windows with EBUSY and take the whole dev server down:
    //   - the art pipeline writing PNGs into assets/ while the server runs
    //   - editors saving a file atomically via a .tmp file inside src/
    // So those two patterns are ignored instead of disabling the watcher outright.
    watch: {
      ignored: ['**/assets/**', '**/*.tmp', '**/*.tmpdir/**', '**/.tmp/**'],
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500
  }
});
