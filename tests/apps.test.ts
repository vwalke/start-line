import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { APPS, HERE } from '../src/apps';

const publicDir = fileURLToPath(new URL('../public', import.meta.url));

describe('app switcher list', () => {
  it('lists the four fleet apps in switcher order', () => {
    expect(APPS.map(({ id, name, description, href }) => ({ id, name, description, href }))).toEqual([
      { id: 'railmath', name: 'Rail Math', description: 'Time-on-time deltas', href: 'https://railmath.walkeforward.com/' },
      { id: 'legwork', name: 'Leg Work', description: 'Range & bearing to every mark', href: 'https://legwork.walkeforward.com/' },
      { id: 'vanncast', name: 'VannCast', description: 'Annapolis racing weather', href: 'https://vanncast.walkeforward.com/' },
      { id: 'recall', name: 'Recall', description: 'Start & leg digest', href: 'https://recall.walkeforward.com/' },
    ]);
  });

  it('marks Recall as the current app', () => {
    expect(HERE).toBe('recall');
    expect(APPS.some((a) => a.id === HERE)).toBe(true);
  });

  it('serves every icon from public/apps', () => {
    for (const app of APPS) {
      expect(app.icon).toBe(`/apps/${app.id}.svg`);
      expect(existsSync(join(publicDir, app.icon))).toBe(true);
    }
  });

  it('links over https with a trailing slash', () => {
    for (const app of APPS) {
      expect(new URL(app.href).protocol).toBe('https:');
      expect(app.href.endsWith('/')).toBe(true);
    }
  });
});

describe('web manifest', () => {
  it('parses and carries the fleet colours', () => {
    const manifest = JSON.parse(readFileSync(join(publicDir, 'manifest.webmanifest'), 'utf8'));
    expect(manifest.name).toBe('Recall');
    expect(manifest.theme_color).toBe('#16181c');
    expect(manifest.background_color).toBe('#131922');
    for (const icon of manifest.icons) expect(existsSync(join(publicDir, icon.src))).toBe(true);
  });
});
