# Recall

A lean **start + leg digest** for a sailboat race, built from the public
[Vakaros RaceSense](https://www.vakaros.com/pages/racesense) data. It's for
racers who find the full analytics overwhelming: pick an event and race, and
you get one screen covering how everyone started, how each leg went, and
what decided the race.

A [Walke Forward](https://walkeforward.com) project, sibling to
[Rail Math](https://railmath.walkeforward.com).

## What it shows

- **Start at the gun:** each boat's bow (GPS tracker + class bow offset)
  against the line with a 30 s trail shifted so it ends on that bow, arrows
  along course over ground, plus the line length and bias and which end was
  favoured. Wind bearings display as 0° rather than 360°.
- **Per boat:** distance off the line at the gun (bow-corrected), seconds late,
  line position (0% pin … 100% RC), speed at the gun, and TWA at the gun.
- **Per leg:** VMG, SOG and TWA, plus leg time and the boat's place at the mark.
  Finish time and race time.
- **Tracks by leg:** a map in local metres (no map tiles), rotated so the wind
  comes from the top.
- **Findings:** plain-English notes: favoured end, best and worst start, the
  biggest single-leg gain and loss, the quickest boats upwind and downwind,
  places gained or lost, and a wind cross-check.
- **Highlights:** ▲ best and ▼ worst in each column. Tap a row or a boat to
  highlight it.

## Data sources & caveats

| Endpoint | Used for | How |
|---|---|---|
| `racesense.vakaros.com/api/landing` | event list | via our `/api` proxy (no CORS upstream) |
| `racesense.vakaros.com/api/regatta?event=` | divisions, entries, course & mark trackers, gun time, start line at the gun, OCS, race-control DTL, finishes | via `/api` proxy |
| `racesense.vakaros.com/api/wind?v=3&…` | modelled wind, used only to cross-check | via `/api` proxy |
| `teleapi.regatta.app/telemetry/event/{id}` | ~5 Hz GPS tracks for boats and marks | via `/api/telemetry/event/{id}` (same-origin proxy; one race window, paginated with `after`) |

- **Unofficial.** These are public but undocumented feeds, read anonymously,
  and they may change without notice. Recall is not affiliated with
  Vakaros.
- **Wind is estimated.** The boats carry no wind sensor. The true wind
  direction comes from the fleet's steady upwind headings: a two-cluster
  circular k-means splits them into the two tacks, and the bisector is the
  wind. It is interpolated in time between beats. If there isn't enough
  upwind data, the app falls back to the weather model, or failing that,
  assumes the first leg is dead upwind, and says so. Every TWA and VMG figure
  is therefore an estimate and is labelled that way.
- **Legs** are split at each boat's closest approach to the mark trackers,
  using a 90 s window that opens when the boat first comes within 45 m. Mark
  positions are followed over time, because committees re-lay marks between
  laps. If most finishers clearly didn't sail the listed course, it is
  treated as shortened.
- **DTL** is computed from the GPS antenna plus the class bow offset. Race
  control's own DTL is shown alongside for reference. The app flags it when
  the two disagree widely, which does happen.
- **"Pin" and "RC"** are the left and right ends of the start line as the feed
  defines them.
- **Politeness:** responses are cached at the edge (Pages Function) and in the
  browser (Cache API). Finished races are cached for a long time, so a repeat
  visit makes no telemetry requests. There is no bulk downloading.

## Architecture

```
src/
  data/types.ts              RaceData: the normalized race model (the seam)
  data/racesense/            RaceSense source adapter (pure) + fetch/pagination
  data/vkx.ts                documented stub for a future .vkx upload source
  data/cache.ts              memory + Cache API caching
  analysis/                  RaceData -> RaceAnalysis (geometry, legs, wind, findings)
  worker.ts                  fetch + normalize + analyze, off the main thread
  ui/                        plain TS + SVG rendering
functions/api/[[path]].ts    Cloudflare Pages Function: cached proxy for landing/regatta/wind/telemetry
functions/_lib.ts            allowlist, query validation and cache TTL (not a route)
tests/                       vitest; offline, using tests/fixtures/benelux_r8.json
scripts/make-fixture.mjs     builds the trimmed fixture from raw downloads
```

The analysis only ever sees `RaceData`. A future `.vkx` upload
([spec](https://github.com/vakaros/vkx)) only needs to produce the same
shape; see `src/data/vkx.ts`.

The algorithms are ported from a Python prototype. Against its output for
Benelux Sailing League Act III, J70 race 8
(`tests/fixtures/benelux_act3_race8_metrics.csv`), the tests reproduce:

- every start and leg metric within the tolerances (DTL ±1.5 m, speed ±0.3 kn,
  TWA ±6°, leg time ±10 s);
- the finish order exactly.

## Local development

Requires Node 20.19+ (CI uses Node 22).

```sh
npm install
npm run dev        # http://localhost:5173 (Vite proxies /api and /api/telemetry)
npm run build && npm run preview   # production build; preview proxies /api too
npm run lint && npm run typecheck && npm test
```

- `?demo=1` loads the bundled Benelux race and works fully offline.
- With no query, the app tries live data: the most recent finished race of
  the most recent event. If the network or proxy fails, it falls back to the
  demo race and shows a notice.
- Deep links: `?event=<eventId>&div=<division>&race=<n>`.

Tests never touch the network. To regenerate the fixture from raw downloads,
run `node scripts/make-fixture.mjs <dir-with-raw-json>`.

## Cloudflare Pages setup

1. Create a Pages project connected to this repo.
2. **Build command:** `npm run build`. **Build output directory:** `dist`.
   **Node version:** set `NODE_VERSION=22`.
3. **Functions:** `functions/` is picked up automatically, and
   `functions/api/[[path]].ts` serves `/api/landing`, `/api/regatta`,
   `/api/wind` and `/api/telemetry/event/{id}`. It only forwards those.
   Query parameters are allowlisted and validated (event id, lat/lon, ISO
   dates; telemetry `after`/`before` as 10–16 digit ms, optional `limit`
   and `division`). Unknown paths and extra parameters are dropped or
   rejected. Landing/regatta/wind responses are buffered (2 MB cap, JSON
   check). Telemetry is streamed (pages can be tens of MB). It caches at
   the edge with `caches.default` when available: landing for 10 min,
   regatta for 2 min while an event is live and 7 days once it has ended,
   wind for 6 h (30 days for past days), and telemetry 7 days when
   `before` is more than a day ago else 60 s. Upstream errors and
   non-JSON landing/regatta/wind bodies are not cached.
4. **No secrets or environment variables are needed.**
5. Custom domain, suggested: `recall.walkeforward.com` (pending confirmation).

To test the function locally: `npx wrangler pages dev dist` after a build.
Wrangler is intentionally not a dependency.

## Known gaps (v1)

- No `.vkx` upload yet; there is only the interface stub.
- Course order comes from the race committee's course list. Shortened
  courses and moved marks are handled, but unusual courses (offset marks
  rounded as one, reaching starts) may need manual review.
- Wind is assumed uniform across the course at any moment. Shifts are only
  interpolated between beats.
- Fleets of more than 8 boats fall back to neutral boat colours, with sail
  numbers as direct labels.
