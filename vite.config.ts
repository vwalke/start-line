import { defineConfig } from 'vitest/config';

// In production /api/* is served by the Cloudflare Pages Function in
// functions/api/. Locally (vite dev / vite preview) we proxy the same
// paths to the two upstream hosts so no Cloudflare tooling is needed.
const apiProxy = {
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
  server: { proxy: apiProxy },
  preview: { proxy: apiProxy },
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
