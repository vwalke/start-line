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
  against the line with a 60 s trail (`START_TRAIL_MS`) shifted so it ends on
  that bow, arrows along course over ground, plus the line length and bias and
  which end was favoured. Wind bearings display as 0° rather than 360°.
  Hulls are drawn to scale when the class is known (division `boatClass`,
  then division name, then the event's class label; e.g. Cape 31 = C31,
  9.55 m); otherwise the caption says there are no dimensions for the class.
  The line continues dashed past each end, and the favoured end is labelled
  with its bias in degrees and metres (and boat lengths when the class is
  known), e.g. `Pin favoured 7° · 18 m (1.9 lengths)`, or `Square line`
  within 2 m. The caption and the label's tooltip give the wind source
  (tacks, weather model, or first leg assumed upwind), a confidence, and how
  far a 5° wind error moves the figure. `Names: Auto | All | Off` sets the
  boat labels: Auto places them greedily (selected boat, then by start place)
  and leaves out any that would overlap another label or the line, so
  zooming in reveals more; hover or tap a boat for its name either way.
- **Per boat:** distance off the line at the gun (bow-corrected), seconds late,
  line position (0% pin … 100% RC), speed at the gun, and TWA at the gun.
- **Per leg:** VMG, SOG, TWA, distance sailed (metres), and leg time with the
  boat's place at the mark, each in its own column under the leg's name.
  Race distance, finish time and race time. Distance sums the GPS track point
  to point; where fixes are more than 5 s apart it's shown as `~` (approximate).
  The analysis also counts each leg's tacks and gybes and its data coverage
  (below), and adds up each boat's upwind and downwind legs (below).
- **Upwind / downwind summaries:** per boat, the beats added up and the runs
  added up (reaches are in neither): total time and distance, SOG = distance ÷
  time, VMG, |TWA| and coverage weighted by leg time, tacks and gybes summed,
  and a place by total time among boats that sailed every leg of that kind
  (ties share a place). A boat missing one gets a partial sum and no place.
- **Tacks and gybes** (`analysis/manoeuvres.ts`): from the GPS track gun →
  finish (plus 30 s before the gun, to know the side held at the start).
  Course over ground comes from the position change over 5 s (never across a
  telemetry gap), against the estimated wind at each moment, giving a signed
  TWA (+ starboard). A side only counts once held for 10 s with |TWA| between
  20° and 160° at 1.5 kn or more, so luffing head-to-wind, sailing by the lee,
  GPS jitter and drifting never count. A change of side is a tack if the TWA
  went through head-to-wind and a gybe if it went through dead downwind; a
  full circle back to the same side (a penalty turn) is neither. Bearing away
  or rounding up at a mark on the same side is not a manoeuvre; a gybe-set or
  a tack around a mark is, and within 15 s of the rounding it is counted on
  the leg it belongs to (a gybe on the run, a tack on the beat). A side change
  across a telemetry hole (> 5 s) is counted but marked approximate (`~`).
  With no fixes for minutes at a time, manoeuvres inside the hole can't be
  seen at all; the coverage figure says when that is likely.
- **Data coverage:** the share of each leg (and of the race) where the boat's
  fixes are at most 5 s apart, and the longest interval between fixes. Below
  90% is flagged as low. The public feed is lossy: some events have holes of
  several minutes.
- **Sorting:** every column header sorts the table, best end first; click
  again to reverse. Missing values always sort last.
- **Tracks by leg:** a map in local metres (no map tiles), rotated so the wind
  comes from the top. The legend picks one leg and zooms the map to it.
- **Colour tracks:** `Colour: Leg | Rank | Boat speed` beside the legend.
  Rank is the elapsed-time scale (reversed plasma: yellow = fastest, through
  orange and magenta to purple = slowest). Rank also sets opacity and width:
  the top 3 bold and on top, the rest of the top quartile strong, the slower
  half faint; grey dashed = didn't complete. On one leg it ranks that leg; on
  the whole race it ranks each leg's segment on that leg, or the whole track
  by race time (`Rank by: Overall`). `Highlight: Top 3 / Top 10` greys out
  everyone else and spreads the colours over just those. Boat speed shades
  every stretch of track by that boat's own speed over ground (4 s mean,
  viridis: dark purple slow, through teal, to yellow-green fast; grey dashed
  = telemetry gap). The scale is the fleet's 5th–95th percentile. On the
  whole race, `Scale: Per leg` (the default) stretches colours over each
  leg's own spread so beats aren't all dark next to planing runs; `Whole
  race` uses one knot range for every leg. Hover a track for the boat, local
  time, SOG and leg. The start chart has its own `Colour: Boat | Speed`:
  Speed paints the 60 s trails and the hulls (SOG at the gun). Selecting a
  boat draws it bold. A picked coach or spare stays grey and dashed and is
  left out of the scale. The choices (and the start chart's `Names`) are
  remembered in this browser.
- **Findings:** plain-English notes, split in two. **Start findings** sit
  under the start chart: the favoured end (in degrees and metres), best and
  worst start, boats over the line or that race control couldn't check.
  **Race findings** follow the track map: the biggest single-leg gain and
  loss, the quickest boats upwind and downwind, places gained or lost, and a
  wind cross-check, with the data warnings below them. An empty list is
  hidden.
- **Highlights:** ▲ best and ▼ worst in each column. Select a boat in the boat
  list, the start chart or a table row to highlight it in both charts, the
  table and both findings lists.

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
- **DTL** comes from each boat's Vakaros device when its start row is valid.
  Our own figure, from the GPS antenna plus the class bow offset, is shown
  alongside as a check. The app flags it when the two disagree widely, which
  does happen. See "Vakaros start data quality" below.
- **"Pin" and "RC"** are the left and right ends of the start line as the feed
  defines them.
- **Politeness:** responses are cached at the edge (Pages Function) and in the
  browser (Cache API). Finished races are cached for a long time, so a repeat
  visit makes no telemetry requests. There is no bulk downloading.

## Vakaros start data quality

Each boat's Vakaros start row (`startingStats`) is the primary DTL figure, and
our own figure from the public track is a check on it. Both can be wrong,
so each is checked before it's used (`src/data/racesense/adapter.ts`,
`src/analysis/validity.ts`):

- **Completeness mask.** `mask.value` is an undocumented bitfield. We inferred
  it from 10,885 rows across 47 events: bit 1 = `dtlMm` (and heading) present
  (set and non-zero in 10,419 rows; unset and 0 in 464; unset but non-zero in
  only 2; set with exactly 0 in none), bit 2 = `positionAtStart`
  (10,368 / 516 / 1 exception), bit 4 = `lineLeftLocation` (10,373 / 511 / 1),
  bit 8 = `lineRightLocation` (10,419 / 463 / 3). Mask 15 covers 9,701 rows;
  every other value 0–14 appears 43–166 times. With bit 1 unset there is no
  distance (shown as —, not 0.0). With bit 1 set, a `dtlMm` of 0 is a genuine
  0.0. With no mask, a null or 0 `dtlMm` counts as missing. Absent points are
  `[0, 0]`.
- **Stale rows.** Rows are sometimes carried over unchanged from an earlier
  start. In one event, 23 rows in races 4–10 had the wrong `raceNumber`.
  A row counts as stale if its `raceNumber` isn't this race, its `startTime`
  is more than 1 s off, or any present line end is more than 10 m from this
  start's line. A stale row is not used, and the note names the race it came
  from when that race can be identified. For a stale row with a positive
  distance, race control's OCS check was blind for that boat.
- **Gaps in our check.** The public track is about 2 Hz but loses points near
  the gun. Our figure is interpolated across the gap if the nearest real point
  is more than 2 s from our sample, or if the hole bracketing the sample is
  longer than 5 s (even when a neighbour is within 2 s). It is shown greyed
  with a `~`, never ranked, and has no Late (s).
- **Disagreement.** If both figures are valid and differ by more than 3 m,
  the Vakaros value gets a ⚠. If Vakaros has no usable fix and our figure is
  under 1 m (near or over the line), the boat is flagged as one race
  control's OCS check had no data for.
- **Ranking** uses one value per boat: Vakaros when it's valid, otherwise ours
  when it's valid, otherwise the boat is unranked. The table's Start column
  shows the place among clean starters and the source (`V` or `ours`).
  Every caveat is listed under the table so it can be read on a phone.

## Architecture

```
src/
  data/types.ts              RaceData: the normalized race model (the seam)
  data/racesense/            RaceSense source adapter (pure) + fetch/pagination
  data/vkx.ts                documented stub for a future .vkx upload source
  data/cache.ts              memory + Cache API caching
  analysis/                  RaceData -> RaceAnalysis (geometry, legs, wind, tacks/gybes, coverage, upwind/downwind summaries, findings)
  worker.ts                  fetch + normalize + analyze, off the main thread
  ui/                        plain TS + SVG rendering
functions/api/[[path]].ts    Cloudflare Pages Function: cached proxy for landing/regatta/wind/telemetry
functions/_lib.ts            allowlist, query validation and cache TTL (not a route)
tests/                       vitest; offline, using tests/fixtures/benelux_r8.json and c31_r10.json
scripts/make-fixture.mjs     builds the trimmed fixtures from raw downloads (--preset benelux|c31)
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

- The app uses live data only. With no query it opens the most recent
  finished race of the most recent event (trying at most four events). If the
  race list can't be fetched it says so and offers a Retry button; if an
  event or race fails to load, the picker stays usable and a notice names
  the failure. Old `?demo=` links are ignored (the parameter is dropped).
- **Search:** the box above the picker filters the event list as you type,
  by title, venue, class, division, dates (including year and month names),
  fleet size or event id. Every word must match; case, accents and
  punctuation don't matter (`j70` finds `J/70`, `malmo` finds `Malmö`).
  `/api/landing` returns every listed event at once, so this covers the whole
  feed. Typing never loads an event: pick one in the Event list, or press
  Enter when exactly one matches. Esc clears the search; `/` focuses it.
- Deep links: `?event=<eventId>&div=<division>&race=<n>`. Add `&nc=all` to keep coach boats and spare trackers as competitors. By default they are set aside, judged from their event results and tracks (`src/analysis/participation.ts`), not from their names.

Tests never touch the network. To regenerate the fixture from raw downloads,
run `node scripts/make-fixture.mjs <dir-with-raw-json>`. Add `--preset c31` to
rebuild the C31 Gold Cup race 10 fixture (the data-quality cases).

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
5. Custom domain: `recall.walkeforward.com`.

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
