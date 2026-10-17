import { defineConfig } from 'vitest/config';

// In production /api/* is served by the Cloudflare Pages Function in
// functions/api/. Locally (vite dev / vite preview) we proxy it straight to
// racesense.vakaros.com so no Cloudflare tooling is needed.
const racesenseProxy = {
  '/api': {
    target: 'https://racesense.vakaros.com',
    changeOrigin: true,
    secure: true,
  },
};

export default defineConfig({
  server: { proxy: racesenseProxy },
  preview: { proxy: racesenseProxy },
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
