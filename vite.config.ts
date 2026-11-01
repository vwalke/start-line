import { execSync } from 'node:child_process';
import { defineConfig } from 'vitest/config';
import { shellChunks } from './vite.chunks';

/** The build's commit for the Feedback sheet (src/feedback/build.ts): Cloudflare Pages' own, else git's, else 'dev'. */
function appCommit(): string {
  const cf = process.env.CF_PAGES_COMMIT_SHA?.trim();
  if (cf && /^[0-9a-f]{7,40}$/i.test(cf)) return cf.slice(0, 12);
  try {
    const sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return /^[0-9a-f]{4,40}$/i.test(sha) ? sha : 'dev';
  } catch {
    return 'dev';
  }
}

// In production /api/* is served by the Cloudflare Pages Function in
// functions/api/. Locally (vite dev / vite preview) we proxy the same
// paths to the upstream hosts so no Cloudflare tooling is needed. (The dev
// proxy has no allowlist and does not strip Yachtscoring's personal fields;
// the app never reads them.)
const apiProxy = {
  '/api/ys': {
    target: 'https://api.yachtscoring.com',
    changeOrigin: true,
    secure: true,
    rewrite: (path: string) => path.replace(/^\/api\/ys/, '/v1/public'),
  },
  '/api/telemetry': {
    target: 'https://teleapi.regatta.app',
    changeOrigin: true,
    secure: true,
    rewrite: (path: string) => path.replace(/^\/api/, ''),
  },
  '/api': {
    target: 'https://racesense.vakaros.com',
    changeOrigin: true,
    secure: true,
  },
};

export default defineConfig({
  define: { __APP_COMMIT__: JSON.stringify(appCommit()), __APP_BUILT_AT__: JSON.stringify(new Date().toISOString()) },
  server: { proxy: apiProxy },
  preview: { proxy: apiProxy },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: true,
    // The entry chunk imported by no other chunk, so index.html's boot-retry can load it afresh (vite.chunks.ts).
    // Not the workers' builds (worker.rollupOptions).
    rollupOptions: { output: { manualChunks: shellChunks() } },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Child processes (the default, pinned): tests/setup.ts yields so a long synchronous file never starves their IPC.
    pool: 'forks',
    setupFiles: ['tests/setup.ts'],
  },
});
