import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { SHOTS } from '../scripts/landing-thumbs.mjs';
import { placesChart } from '../src/ui/places';
import { laneScrub } from '../src/ui/laneSnapshots';
import { laneScrubHtml } from '../src/ui/laneSnapshotsView';
import { ic37Race } from './helpers';

/** The section titles: the six renamed ones in the app, the landing page and the screenshot script; the old ones gone. */
const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const css = readFileSync(fileURLToPath(new URL('../src/style.css', import.meta.url)), 'utf8');
const NEW = ['Start View - Gun', 'Start Playback', 'Start Speed Control', 'Rounding &amp; Finish Positions', 'Race Analysis', 'Performance Metrics'];
// As titles (capitalized); the landing copy still says what the speed chart shows: "each boat's speed through the start".
const OLD = /Start at the gun|Around the gun|Speed through the start|Place changes|Race findings|Legs by boat/;
const panel = (id: string): string => html.slice(html.indexOf(`id="${id}"`), html.indexOf('</div>\n          <div id="panel-', html.indexOf(`id="${id}"`) + 1));

describe('section titles', () => {
  it('the app shows the six new titles (the hyphen plain ASCII with a space either side, & escaped), and none of the old', () => {
    const start = panel('panel-start');
    expect(start).toContain('<h3>Start View - Gun</h3>');
    expect(start).toContain('<summary class="act-more">Start Playback <span class="muted">(−1:30 to +3:00)</span></summary>');
    expect(start).toContain('<h3 id="start-sog-title">Start Speed Control</h3>');
    const race = html.slice(html.indexOf('id="panel-race"'), html.indexOf('id="panel-coach"'));
    expect(race).toContain('<h3 id="places-title">Rounding &amp; Finish Positions</h3>');
    expect(race).toContain('<h3 id="race-findings-title">Race Analysis</h3>');
    expect(race).toContain('<h3>Performance Metrics</h3>');
    expect(race).toContain('aria-label="Full screen Rounding &amp; Finish Positions chart"');
    for (const t of NEW) expect(html).toContain(t);
    expect(html).not.toMatch(OLD);
    expect(html).not.toMatch(/Rounding & Finish/);
  });

  it('the landing cards and their screenshots use the new names', () => {
    const landing = html.slice(html.indexOf('<main id="landing"'), html.indexOf('</main>'));
    expect(landing).toContain('<h3>Start Playback</h3>');
    expect(landing).toContain('<h3>Rounding &amp; Finish Positions</h3>');
    expect(SHOTS.map((s: { card: string }) => s.card)).toEqual(expect.arrayContaining(['Start Playback', 'Rounding & Finish Positions']));
    expect(SHOTS.some((s: { card: string }) => OLD.test(s.card))).toBe(false);
  });

  it('the charts\' aria labels say the new names', () => {
    const a = analyzeRace(ic37Race());
    expect(placesChart(a, null)).toContain('aria-label="Rounding &amp; Finish Positions: each boat');
    const lane = laneScrubHtml(a, laneScrub(a, { me: null }));
    expect(lane).toContain('aria-label="Start Playback map zoom"');
    expect(lane).toContain('aria-label="Start Playback map. Arrow keys pan when zoomed');
    expect(lane).not.toMatch(OLD);
  });

  it('titles are larger and bolder, with a thin rule (the theme border color) between the start chart\'s chips and Start Playback, phones included', () => {
    expect(css).toMatch(/\.card > h3, \.lane-snapshots > summary, \.coach-legs-head h3 \{ font-size: 1\.12rem; font-weight: 700;/);
    expect(css).toMatch(/\.card > \.lane-snapshots, \.card > \.findings-box \{ margin-top: 18px; padding-top: 14px; border-top: 1px solid var\(--rule\); \}/);
    expect(css).toMatch(/@media \(max-width: 600px\) \{\n {2}\.card > h3, \.lane-snapshots > summary, \.coach-legs-head h3 \{ font-size: 1\.05rem; \}/);
    // Start Playback comes after the chips row and the over-early line, inside the same card.
    const start = panel('panel-start');
    expect(start.indexOf('id="start-cap"')).toBeLessThan(start.indexOf('id="start-replay"'));
    expect(start.indexOf('id="start-replay"')).toBeLessThan(start.indexOf('id="lane-snapshots"'));
  });
});
