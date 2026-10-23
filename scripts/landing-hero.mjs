#!/usr/bin/env node
// Draws the landing page's hero (public/landing-hero.svg): a real race's track map, from a test
// fixture through the app's own code (data/racesense/adapter.ts buildRaceData, analysis/analyze.ts,
// landing/hero.ts, loaded through Vite's SSR loader so no build step or extra tool is needed).
// Sail numbers only; never a boat's, owner's or crew's name.
//   node scripts/landing-hero.mjs           write public/landing-hero.svg
//   node scripts/landing-hero.mjs --check   fail when the committed file is stale
// The fixture: J/105 CBC 2026, race 3 (tests/fixtures/j105_r3.json); tests/landing.test.ts checks the file is current.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'public', 'landing-hero.svg');
const HERO_FIXTURE = { file: 'tests/fixtures/j105_r3.json', division: 'J105', raceNumber: 3 };

const server = await createServer({
  root,
  configFile: false,
  logLevel: 'error',
  appType: 'custom',
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  const { heroFromFixture } = await server.ssrLoadModule('/src/landing/heroFixture.ts');
  const f = JSON.parse(readFileSync(join(root, HERO_FIXTURE.file), 'utf8'));
  const svg = heroFromFixture(f, HERO_FIXTURE.division, HERO_FIXTURE.raceNumber);
  if (process.argv.includes('--check')) {
    if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== svg) {
      console.error('public/landing-hero.svg is stale. Run node scripts/landing-hero.mjs.');
      process.exitCode = 1;
    } else console.log('Landing hero up to date.');
  } else {
    writeFileSync(OUT, svg);
    console.log(`Wrote public/landing-hero.svg (${(svg.length / 1024).toFixed(1)} KB)`);
  }
} finally {
  await server.close();
}
