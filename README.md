# Recall

A lean **start + leg digest** for a sailboat race, built from the public
[Vakaros RaceSense](https://www.vakaros.com/pages/racesense) data. It's for
racers who find the full analytics overwhelming: pick an event and race, and
you get one screen covering how everyone started, how each leg went, and
what decided the race.

A [Walke Forward](https://walkeforward.com) project, sibling to
[Rail Math](https://railmath.walkeforward.com).

## What it shows

Under the race header the digest has two tabs, **Start** and **Race**; the
boat list beside (on a phone, above) them and the selected boat are shared by
both.

- **Start tab:** the start chart with its start findings, speed through the
  start, and the Start by boat table.
- **Race tab:** the tracks-by-leg map, place changes, the race findings and
  warnings, and the Legs by boat table with the Upwind / Downwind summaries.

Each table stays on the tab with the charts it's read against, because
picking a boat in a chart and finding its row (or the reverse) is the main
way they're used; a separate Tables tab would split every such pair. The tabs
are a tablist (arrow keys, Home / End) that sticks under the boat strip on a
phone. The tab is in the URL hash (`#start`, `#race`; replaced, never added to
history) and kept with the last race viewed. A hash on the URL wins; a link
without one opens Start, or the saved tab when it reopens the saved race.
Switching races keeps the tab.

- **Start at the gun:** each boat's bow (GPS tracker + class bow offset)
  against the line with a 60 s trail (`START_TRAIL_MS`) shifted so it ends on
  that bow, arrows along course over ground, plus the line length and bias and
  which end was favoured. Wind bearings display as 0° rather than 360°.
  Hulls are drawn to scale when the class is known (division `boatClass`,
  then division name, then the event's class label; e.g. Cape 31 = C31,
  9.55 m); otherwise the key line says `hulls not to scale` (and the ⓘ why).
  The line continues dashed past each end, and the favoured end is labelled
  with its bias in degrees and metres (and boat lengths when the class is
  known), e.g. `Pin favoured 7° · 18 m (1.9 lengths)`, or `Square line`
  within 2 m. The label is small text running along the favoured end's
  dashed extension, starting a clear gap past the pin or RC mark and sitting
  just above the line: "above" is screen-up once the text is turned upright
  (it flips 180° rather than read upside down), which with the wind at the
  top is the course side, away from the boats. It scales with the view like
  the boat names, so it reads the same at every zoom. It always takes the
  longest wording that fits on the extension and keeps the metres:
  `Pin favoured 7° · 18 m (1.9 lengths)`, then `Pin favoured 7° · 18 m`,
  `Pin fav. 7° · 18 m`, `Pin 7° · 18 m`. The Fit view leaves room past the
  favoured end for one of those: `Pin favoured 7° · 18 m` on a wide chart
  (the frame grows up to 25%), and on a chart under 480 px wide, where the
  text is larger, the longest that fits with the frame grown up to 35% (that
  frame changes only when the chart crosses 480 px). The lengths join when
  zoomed in. Only if none fits does the label run along the line inward from
  that end (as `Pin 7°` at worst). `Square line` sits centred along the line.
  The wind chip (`wind est. (medium)`) and the label's tooltip give the wind
  source (tacks, weather model, or first leg assumed upwind) and a
  confidence; low confidence is a ⚠ chip. The ⓘ says how far a 5° wind
  error moves the figure. `Names: Auto | All | Off` sets the
  boat labels: Auto places them greedily (selected boat, then by start place)
  and leaves out any that would overlap another label or the line, so
  zooming in reveals more; hover or tap a boat for its name either way.
- **Key lines** (`ui/info.ts`, `ui/captions.ts`): under every chart and
  table, one short row of chips with the key facts only, e.g.
  `Line 143 m · RC fav. 2° · 4 m · wind est. (medium) · hulls to scale`,
  plus legend swatches (`- - line extended`, `- - no data`, `○ estimated
  mark`, `- - not racing`, `● crossed the line`). Caveats stay in sight as
  red ⚠ chips: low wind confidence (`⚠ wind est. low`, `⚠ wind assumed`),
  low data, gaps across the gun, Vakaros vs our check, unchecked OCS,
  missing roundings, a start window cut short, legs split from the fleet's
  turns (on the Race findings card). The row ends in one ⓘ
  "How to read this" (a native `<details>`, closed by default; it stays
  open across redraws) with a few short bullets: methods, what dashed
  means, sensitivity (±5° of wind ≈ ±N m), label meaning, Names modes,
  gestures, and for the start table each boat's start caveats. Full screen
  shows the same key line.
- **Zoom hint:** "Pinch to zoom · drag to pan · double-tap to zoom in"
  shows under the start chart on touch devices only (`(pointer: coarse)`),
  until it's dismissed with × or by the first pinch, pan or double-tap; the
  dismissal is kept in `recall.hints` (`ui/hints.ts`; blocked storage just
  shows it again next visit). Desktop gestures are in the start chart's ⓘ.
- **Full screen** (`ui/fullscreen.ts`): the expand button at the top right
  of the start chart, the track map and the place changes cards opens that
  chart over the whole viewport, with its own controls in a compact top bar
  (start chart: Fit / 2× / 4× / 8×, Colour, Names; map: the leg picker and
  Colour) and its key (the speed scale, or each boat's colour for a fleet of
  up to eight) with the card's key line and ⓘ, as inline. Pinch, pan and tap-to-select
  work as inline, and the selected boat, zoom and Names are shared with the
  page, so they carry in and back out. The overlay is a fixed layer
  `100dvh` tall inside the safe-area insets (the page uses
  `viewport-fit=cover`, with its own padding kept clear of a notch); where
  the browser has element fullscreen it is also asked for, and where it
  hasn't (iPhone Safari) or refuses, the overlay alone is used. Close with
  the × button, Esc, the browser's own fullscreen exit, or the back
  gesture: opening pushes one history entry (same URL and tab hash, marked
  in its state) so Android / browser back closes the overlay rather than
  leaving the page, and closing any other way pops it, so history doesn't
  grow. While open the page underneath is inert and doesn't scroll (its
  scroll position is restored), Tab stays inside, and focus returns to the
  expand button on close. In full screen the start chart's Fit
  (`startFullFrame`) frames the line and the bows at the gun with margins
  for the names and the favoured-end label, then grows to the screen's own
  aspect, so the fleet fills the width. The spare height always goes below
  the line, to the trails (the line sits near the top under just its margin
  for names, PIN/RC and the wind arrow). Text stays ~10 px at any size, so a
  big screen draws the hulls to scale. Inline, Fit also takes in every trail
  near the line and the chart keeps that frame's aspect, so a long line on a
  phone is a thin strip (a 500 m line is ~0.5 px per metre at 390 px); in
  landscape full screen the same start is drawn about 2.5× larger. In
  portrait, a wide start shows a dismissible "Rotate to landscape for a
  bigger view" (the orientation is never forced); the chart is redrawn on
  every resize or rotation. The place changes chart fits the overlay's
  height when that leaves each row at least 12 px (growing a small fleet's
  rows up to 32 px); otherwise it keeps its usual rows and scrolls inside
  the overlay. On closing, the page's scroll position and focus on the
  expand button are restored once the browser has left native fullscreen
  (Chrome resets both on its way out), and again on the next frame.
- **Speed through the start** (Start tab, after the start chart;
  `analysis/startSog.ts`, `ui/startSog.ts`): each racing boat's speed over
  ground (the same 4 s mean the speed-coloured tracks use) against seconds
  from the gun, with the gun as a dashed line. `Window: 30 s | 60 s | 120 s`
  sets how far before the gun it starts (it always runs to +20 s; remembered
  in `recall.startSogWindow`, default 60). The analysis keeps every fix from
  120 s before the gun to 20 s after, and the live feed is fetched from 130 s
  before the gun to allow for it; if no boat's track goes back as far as the
  window, the chart starts at the earliest data and a ⚠ chip says so.
  A line breaks wherever a boat's fixes are more than 5 s apart (the same
  threshold as the distance `~` and Data %), with a grey dashed join, so a
  hole is never drawn as a speed; hovering inside one shows nothing. A dot
  marks where each boat crossed the line (the start table's Late) and its
  speed then ("crossed +2.6 s at 5.3 kn"). Hover or tap for the speed under
  the pointer (the selected boat's, else the nearest line's) with a
  crosshair; tap a line to select the boat. Not racing boats are left out.
- **Start by boat** (Start tab, a table after the start charts): finish
  place, start place, distance off the line at the gun (Vakaros and our
  check, bow-corrected), seconds late, line position (0% pin … 100% RC),
  speed at the gun, TWA at the gun and heel at the gun, with each boat's start
  caveats listed under it.
- **Legs by boat** (Race tab, a table after the map, place changes and race findings): finish place,
  start place, then per leg VMG, SOG, TWA, heel, distance sailed (metres), leg time
  with the place at the mark, tacks (on beats) or gybes (on runs; both on
  reaches) and Data %; then the same for **Upwind** and **Downwind**, then the
  race: distance, race and finish time, average SOG, tacks, gybes and Data %.
  Distances are whole metres with a thin-space thousands separator
  (`12 345`). Distance sums the GPS track point to point; where fixes are
  more than 5 s apart it's shown as `~` (approximate), and so is a tack or
  gybe count where one bridges a gap. Data % below 90% is flagged ⚠ with how
  much of the leg had data and the longest gap.
- **Place changes** (Race tab, after the track map; `analysis/places.ts`,
  `ui/places.ts`): a bump chart of each boat's place at the start, at every
  mark rounding (named as the legs name them; a repeat is "M1 (2)") and at
  the finish, 1 at the top. Start is the start table's place among clean
  starters (an OCS boat, or one with no reliable figure, has no start
  point); each mark is the order of the rounding times from the leg splits
  (a leg's end, or the next leg's start when that leg broke), among the boats
  with a time there, with equal times kept in the legs table's order; Finish
  is the finish order. A boat with no rounding time at a mark (a telemetry
  gap) is left out of that mark's order, so the others close up, and its line
  is dashed grey across it; nothing is guessed. A DNF's line stops at the
  last mark reached and is labelled "DNF" there. Boats set aside as not
  racing are not drawn. When the legs come from where the fleet turned (no
  mark trackers) the marks are those turns; a one-leg race is Start → Finish.
  Lines use the boat colours (past eight boats the colours repeat; the
  labels at the right, "1 Savasana", name them). Hover or tap a dot for
  "#GER42 · Gate: 3rd (+2)": the place there and the places gained (+) or
  lost (−) since the boat's last place. Tap a line, dot or name to select the
  boat everywhere; the others fade. On a narrow screen the labels are sail
  numbers and the mark names are turned.
- **Wide tables:** each has a second scrollbar above it, kept in step with
  its own (which sits directly under the table, with the key line below that).
  Fin and Boat (and Rank, once sorted) stay put while the rest scrolls; on a
  phone long boat names are cut short (the sidebar has them). A 2 px divider
  runs down the start of each column group (each leg, Upwind, Downwind,
  Race), header to last row.
- **Upwind / downwind summaries:** per boat, the beats added up and the runs
  added up (reaches are in neither): total time and distance, SOG = distance ÷
  time, VMG, |TWA| and coverage weighted by leg time, heel time-weighted over
  every fix it rests on across those legs, tacks and gybes summed,
  and a place by total time among boats that sailed every leg of that kind
  (ties share a place). A boat missing one gets a partial sum, shown in grey
  italics as "partial 1/2", and no place.
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
- **Heel** (`analysis/heel.ts`): from each tracker's motion sensor (the feed's
  `roll`, integer degrees; `roll` < 0 is heeled to port, which is what every
  fleet shows upwind on starboard tack). Shown as *leeward heel* =
  −roll × sign(TWA), using the signed TWA above: + heeled to leeward, −
  heeled to windward (roll-tacking, light-air windward heel, a run sailed
  heeled to weather). Head to wind and dead downwind (|TWA| under 20° or over
  160°) the side is unclear and a fix has no leeward heel. Per leg and per
  Upwind / Downwind summary it is time-weighted (each fix holds until the
  next; never across a gap over 5 s), leaving out 5 s either side of each
  tack or gybe, where heel swings through zero. Heel at the gun is the fix
  nearest the gun within 2 s. A heel cell is flagged ⚠ when the leg had heel
  readings for under 90% of its time. Readings of ±90° or more (a sensor
  clamp on coach and spare trackers) and runs of exactly 0° roll and 0° pitch
  lasting 10 s or more while moving (a device sending no IMU) count as
  missing; brief 0/0 readings are real and kept. Feeds without `roll` (older
  events) hide the heel columns and say so in the tables' ⓘ. Trim (`pitch`)
  is read and averaged per leg but not shown: it carries each tracker's own
  mounting angle (boats in one fleet sit 13° apart on every leg), so it
  doesn't compare between boats.
  With no fixes for minutes at a time, manoeuvres inside the hole can't be
  seen at all; the coverage figure says when that is likely.
- **Data coverage:** the share of each leg (and of the race) where the boat's
  fixes are at most 5 s apart, and the longest interval between fixes. Below
  90% is flagged as low. The public feed is lossy: some events have holes of
  several minutes.
- **Sorting:** every column header sorts its table, best end first; click
  again to reverse. Missing values always sort last. The two tables sort
  independently, and both sorts are kept with the last race viewed (a sort
  saved before the split goes back onto whichever table has that column).
- **Rank:** once a table is sorted, a narrow Rank column (leftmost, pinned)
  gives each boat's place in that sort, 1 at the top in either direction;
  ties share a place ("=3", then 5), a missing value or a not-racing boat
  shows "—". Its header names the sorted column. In finish order (no sort)
  it is hidden: Fin already gives that order, and a phone keeps the width.
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
  **Race findings** (Race tab) follow the place changes: the biggest single-leg gain and
  loss, the quickest boats upwind and downwind, places gained or lost, and a
  wind cross-check. Below them, the race's data caveats (`RaceAnalysis.notes`,
  typed; `warnings` keeps the full sentences) are a key line: ⚠ chips for
  what changes how the numbers read (`⚠ legs split from turns`, leg order
  from tracks, course shortened, wind assumed, Vakaros DTL off vs GPS, a
  finish not ranked), plain chips for the rest (`windward mark est.`,
  `5 not racing`, `Gate moved`, `model wind`), and the why as short bullets
  in the card's ⓘ; each chip's tooltip has the full sentence. An empty list
  is hidden.
- **Highlights:** ▲ best and ▼ worst in each column. Select a boat in the boat
  list, the start chart or a table row to highlight it in both charts, both
  tables and both findings lists.

## Data sources & caveats

| Endpoint | Used for | How |
|---|---|---|
| `racesense.vakaros.com/api/landing` | event list | via our `/api` proxy (no CORS upstream) |
| `racesense.vakaros.com/api/regatta?event=` | divisions, entries, course & mark trackers, gun time, start line at the gun, OCS, race-control DTL, finishes | via `/api` proxy |
| `racesense.vakaros.com/api/wind?v=3&…` | modelled wind, used only to cross-check | via `/api` proxy |
| `teleapi.regatta.app/telemetry/event/{id}` | ~5 Hz GPS tracks for boats and marks, with heel (`roll`) and trim (`pitch`) | via `/api/telemetry/event/{id}` (same-origin proxy; one race window, paginated with `after`) |

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
  analysis/                  RaceData -> RaceAnalysis (geometry, legs, wind, tacks/gybes, heel, coverage, upwind/downwind summaries, place changes, findings)
  worker.ts                  fetch + normalize + analyze, off the main thread
  ui/                        plain TS + SVG rendering
functions/api/[[path]].ts    Cloudflare Pages Function: cached proxy for landing/regatta/wind/telemetry
functions/_lib.ts            allowlist, query validation and cache TTL (not a route)
tests/                       vitest; offline, using tests/fixtures (benelux_r8, c31_r10, m24_r4, j88_r5)
scripts/make-fixture.mjs     builds the trimmed fixtures from raw downloads (--preset benelux|c31|m24|j88)
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
- Deep links: `?event=<eventId>&div=<division>&race=<n>`, optionally with `#start` or `#race` for the tab. Add `&nc=all` to keep coach boats and spare trackers as competitors. By default they are set aside, judged from their event results and tracks (`src/analysis/participation.ts`), not from their names.

Tests never touch the network. To regenerate the fixture from raw downloads,
run `node scripts/make-fixture.mjs <dir-with-raw-json>`. Add `--preset c31` to
rebuild the C31 Gold Cup race 10 fixture (the data-quality cases), `--preset m24`
or `--preset j88` for the Melges 24 and J/88 ones. The fixtures keep `roll` and
`pitch` (heel and trim) alongside the position columns.

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
