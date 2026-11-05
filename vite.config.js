import { defineConfig } from 'vite';

export default defineConfig({
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
