# Recall

A lean **start + leg digest** for a sailboat race, built from the public
[Vakaros RaceSense](https://www.vakaros.com/pages/racesense) data. It's for
racers who find the full analytics overwhelming: pick an event and race, and
you get one screen covering how everyone started, how each leg went, and
what decided the race.

A [Walke Forward](https://walkeforward.com) project, sibling to
[Rail Math](https://railmath.walkeforward.com).

## Pages

- **`/`** with no app parameters: the landing page (static HTML in `index.html`, `#landing`; what Recall
  does, pricing, where the data comes from, the other Walke Forward apps). It loads none of the app and
  fetches nothing from RaceSense; with a race viewed before, it offers "Continue: <event · race>" (to
  `/regattas`). The hero, `public/landing-hero.svg` (and `landing-hero-night.svg` for Dark), is a real race
  drawn by `node scripts/landing-hero.mjs` from `tests/fixtures/j105_r3.json` (sail numbers only); a test
  fails when either is stale. The page shows the one that matches the theme. Each feature card
  has a thumbnail (lazy, 320×200 with a 2x file) that opens a full-size image in a native `<dialog>`
  (`src/landing/lightbox.ts`); only the thumbnails load with the page. The images in `public/landing/` are
  screenshots of the running app on public demo races, made by `scripts/landing-thumbs.mjs` (below).
- **`/regattas`**: the app's event picker, as `/` used to be (reopens the last race viewed, else the latest).
  The installed web app starts here.
- **Every other URL** is the app, unchanged: any `/` link with an app parameter (`event`, `div`, `race`,
  `nc`, `ys`, `ysc`, `boat`, `grp`, `cview`, `t`, `trail`, `report`, `buy`, `checkout`, `signin`, …: anything
  but `utm_*`-style tagging) or hash (`#start`, `#race`, `#coach`, `#report`). The rule is
  `src/landing/route.ts` `routeOf`, mirrored by an inline script in `index.html` so the right page shows
  before first paint. Cloudflare Pages serves `index.html` for `/regattas` (no `404.html`: single-page
  fallback), so there is no `_redirects`.

**Landing thumbnails.** `scripts/landing-thumbs.mjs` drives headless Chrome with Playwright against a running
Recall server and writes `public/landing/<slug>-thumb.webp`, `<slug>-thumb@2x.webp` and `<slug>.webp` for each
card (slugs: `replay`, `track-colors`, `start`, `around-the-gun`, `legs`, `places`, `debrief`, `regatta`,
`report`, `official-results`). Playwright isn't a dependency: point `PLAYWRIGHT_CORE` at an installed
`playwright-core/index.js` (else the bare import is tried) and `CHROME` at Chrome (default
`/usr/bin/google-chrome`). The PNGs are re-encoded to WebP in the same Chrome (canvas `toBlob`), with the
quality stepped down until a thumbnail is at most 60 KB and a full image at most 250 KB.

```sh
npx vite --port 5173 --strictPort &
PLAYWRIGHT_CORE=/path/to/playwright-core/index.js node scripts/landing-thumbs.mjs --base http://localhost:5173
#   --only replay,start   some shots only      --png-dir /tmp/png   keep the raw captures (a failed shot's too)
```

Use a port Node's `fetch` accepts: undici refuses its "bad ports" (4190 is one), and the script checks the server
with `fetch` first.

The races are the J/70 Worlds in Cascais (Open, `race=4`, USA 833 for Start Playback and the regatta view; the replay is
`race=3` at the windward mark, a moment picked from `tests/fixtures/cascais_r3.json` where nearly every boat near
USA 833 has fresh fixes) and the J/105 CBC (`race=1`, linked to Yachtscoring 50575; the debrief and report are
`race=3` for USA 343, which covers 85% of that race on its fixture, against USA 833's thin Cascais tracks). The start
is the 2026 IC37 North American Championship (`race=4`), its start chart in full screen (Fit, Color: Speed,
Names: Auto) without the bar of controls above it: the thumbnail at 1280×800, the full image with the
viewport cut down to just under the tracks. Sail numbers only: the script removes boat names and Yachtscoring's
owner and crew fields from the responses before the page sees them, hides `.bname` / `.rp-name`, and fails a
shot if any removed name is still in the captured element (whole words, case as written; one-word names that are
also the app's own words, `NOT_NAMES` such as "Mark", are skipped). Look over every image before committing it anyway.

## What it shows

The masthead's sub-title, "Replays and debriefs for RaceSense races.", is written once, in
`index.html` (`<p class="tag">`); `npm run icons` copies it into the web
manifest's description. Under the race title one line gives the gun on the
venue's clock, marked `(local)` (and your own clock when it differs), the
number of boats and legs (`4 legs`) and the data source.

Under the race header the digest has three tabs, **Start**, **Race** and
**Coach**; the boat list beside (on a phone, above) them and the selected boat
are shared by all three.

- **Start tab:** the start chart (Start View - Gun) with Start Playback and its
  start findings, Start Speed Control, and the Start by boat table.
- **Race tab:** the Race Viewer map, Rounding & Finish Positions, Race Analysis
  (the findings and warnings), and the Performance Metrics table with the
  Upwind / Downwind summaries.

Each section has a larger, bold title; a section inside a card (Start Playback,
under the start chart's chips and over-early line; the start findings) is set
off by a thin rule in the theme's border color.

**Theme:** System (default), Light or Dark, a segmented control under **Theme**
in the account sheet (signed in or not). It is kept in this browser's
localStorage (`recall.theme`; there is no account-side preference, so it
doesn't follow a sign-in to another device). A small inline script in
`index.html` (and on the sign-in link pages, allowed by its CSP hash) reads it
and sets `<html data-theme="light|dark">` before first paint, so there is no
flash; `functions/_theme.ts` holds the script and the rules, `src/theme.ts`
follows the device's setting under System and a change made in another tab.
Every Night color in `style.css` is keyed off `:root[data-theme='dark']` (the
tokens, the night speed ramps for tracks, hulls and bars, the chips), never
the `prefers-color-scheme` media query, so the override reaches every view.
The landing hero is two files, one per theme. The masthead stays carbon in both.
- **Coach tab** (on for everyone; the old `?coach=1` is ignored): the boat
  selected in the boat list (or a chart) in the race picked in the Race menu.
  It has no race or boat picker of its own; with no boat selected it asks for
  one. Two views, picked with the large **Race | Regatta** switch at the top
  of the tab (full width on a phone):
  - **Race:** its place (official when linked) and the gap to the winner, the
    gap to a group of rivals (Top 3 / boats near me / whole fleet / custom)
    over the race with the fleet's wind under it (seconds at equal course
    progress, `src/analysis/coach/timeGap.ts`: how much earlier or later each
    rival got as far along the course. On beats and runs "how far" is the
    share of the leg's wind ladder climbed, along one wind for the whole leg
    (the fleet's mean on it), scaled to the rhumb length, so a leg skewed to
    the wind doesn't favor one tack or gybe; on reaches, distance made good
    along the rhumb line. A rounding is a zone from `ROUNDING_IN_M` = 30 m
    before the mark to `ROUNDING_OUT_M` = 30 m down the next leg, crossed
    linearly in time by every boat, so roundings neither spike nor break the
    lines. The finish is anchored to the finish times: the last leg is
    measured to the line the finishers crossed (fitted through where they
    were at their finish times, else the feed's; extended past its ends), and
    the last `FINISH_IN_M` = 30 m are a zone crossed linearly in time up to
    each boat's finish time, so at your finish each rival reads the finish
    times' difference (the feed's line can be off: J/70 Worlds race 3's boats
    crossed it 14–29 s before their finish times). The group line is bold, over a fixed set of boats: at each
    point the mean of the boats with data when there are `GROUP_MEAN_MAX_BOATS` = 5 or fewer, their median when
    there are more (the legend says which: "(mean)", "(median)", or "(mean / median)" when it changes); the bold
    series reads a rival across a tracker hole of up to `GROUP_BRIDGE_S` = 10 min in a
    straight line (progress is monotone), so the line doesn't jump when boats
    round or their trackers go quiet; it has a value only where at least half the
    group's gaps rest on holes of `GROUP_DRAW_HOLE_S` = 30 s or less. Thin lines'
    values keep the position rule (fixes at most 15 s apart, read within 5 s
    of one; on a stretch that starts or ends at a rounding-zone edge, linear in
    time by construction, only the 15 s rule, so ~10 s tracks don't drop points
    there). A gap between fixes where the boat made no progress (a tack back, a
    stall in a rounding zone) isn't a hole. The gap scale fits every thin line
    for 5 or fewer boats; with more it follows the bold line plus some headroom
    and marks a thin line that runs off it at the edge. On the chart (display only),
    every line runs straight on across any stretch without values, however long:
    no breaks, no bands, no "no data" chip, and the readout says only the statistic
    and how many boats ("median of 6 boats"), never that any was estimated; the
    wind strip's estimated minutes are the same line, lighter. The cards read the
    same series (`groupGap`), with its holes and rules as above, so
    a card's seconds are the chart's change for the same group), the biggest gains as cards
    ranked by their impact on the result (see [How the Coach ranks
    cards](#how-the-coach-ranks-cards); at most 3, at most 2 from one detector:
    the next-best from another takes the slot; penalty turns exempt),
    **Went well** (up to 3 lines with the seconds gained: legs, roundings
    and the start where the boat gained on the top 3), the ✓ "Not the
    problem" chips (on a stretch the tracker covered under 50 % a chip under
    "Not judged" instead, just what it is: "banked gains", never a ✓), and a
    story per leg. Works on every race the menu offers,
    rebuilt and tracker-only ones included.
  - **Regatta:** the same boat over every race the Race menu lists (its
    numbering; practice left out; rebuilt and tracker-only races in). A row of
    places (official, else RaceSense's or the tracker's `~`, "of N"); the top 3
    things to work on as cards, a finding found in 2+ races being a **pattern
    card** ("Leeward roundings cost you time in 3 of 4 races judged",
    a chip per race with its seconds, and the tip); **Went well** over the
    regatta (up to 3 families: "Beats: gained on the top 3 in 2 of 4 races
    (best R2 Beat 2, 55 s)"); the ranked table of recurring findings; best
    and worst legs by type against the fleet's median leg time. All by fixed
    rules (no AI). A race with tracker coverage under 80 % has its seconds
    weighted down in proportion (not marked on screen). The races are analyzed on
    first opening, one at a time on a second worker (`src/ui/coachRegatta.ts`,
    `src/analysis/coach/regatta.ts`) with progress, and cached for the visit;
    the race on screen is never held up.

  The group, boat and view are in the URL (`grp=`, `boat=`, `cview=regatta`).

  The detectors (`src/analysis/coach/detectors/`) follow the Coach spec's table;
  phase 4 added the two that need dense data:
  - **D9 mark rounding** (`rounding.ts`): the time from 100 m in to 100 m out of
    the mark rounded (read where the track crosses the circle; both buoys of a
    gate count), and the exit, the distance across the next leg's line through
    the mark 2 boat lengths down it. Only timed with a fix at least every 2 s
    within 60 m of the mark (and ≤ 5 s apart in the zone); the public feed
    mostly fails that, an uploaded log passes. Compared with the top 3 that
    pass the same gate (2 or more); else with the boat's own other roundings of
    that kind of mark (confidence at most medium); else with two or more other
    boats with data (low); the card says which ("no leader data"). Fires at
    8 s or more slower than the reference median, or an exit more than 2 lengths
    wider; seconds = Δ time in the zone ("Leeward gate, 2nd rounding: 9 s slower
    than the leaders through the zone, exited 3 lengths wide"). A mark placed
    from the fleet's turns (no tracker) is suppressed. A rounding 5 s or more
    quicker than the top 3 is a Went well line.
    **Low-resolution fallback** (`placesThrough`, `src/analysis/coach/progress.ts`):
    wherever the zone time can't be used (the coverage gate fails, no reference
    passes it, or the mark is estimated), the boat's place in the fleet is read
    by distance to go along the course (the wind ladder to its mark plus the
    legs after; the leg table's fixed fleet; a sparse track's position read
    across gaps up to 60 s, otherwise interpolated between its rounding times)
    at its own fix nearest 60 s before the rounding (20 s–2 min) and the same
    after.     Losing max(3, min(5, ceil(5 % of the fleet))) places or more (3 up to
    60 boats, 4 to 80, 5 beyond) is a card at medium confidence ("Windward
    mark: lost 7 places through the rounding, 10th → 17th of 100 (read from the
    places through it)"); seconds = the change in the chart's gap to the boats
    that passed it (Custom: them; its points nearest the two reads). The boat's own
    places must be from a position (a hole at the read is not judged); only
    boats measured at both reads count as passers. DNS/DNC and tracked boats
    official results don't list are left out of the ranking; a DNF/RET is not
    carried past its last known mark. If the boats that
    came in from the other side within 3 minutes gained 2+ places more on
    average than the boat's side, and two thirds of those that passed it came
    from there, the card says it looks like a shift, the seconds are halved and
    the confidence is low. Low too when over half the fleet's places are
    interpolated; over three quarters, not judged at all. The 10 Hz zone time
    always wins when coverage allows. Fallback findings count in the Regatta
    view like any other, their confidence on the race chip ("R2 25 s (medium)").
  - **D8 dirty air** (`shadow.ts`): in the first 6 minutes of each beat, a boat
    0.5–7 lengths from another and within ±22° of its plume (downwind of it,
    swung toward its stern by half its angle to the wind, at most 20°) is in its
    shadow. Positions every 5 s, read only between fixes ≤ 6 s apart; a moment
    counts only when 60 % of the boats racing then have one, and the boat needs
    half its moments counted (else not evaluated). Fires at a share in shadow of
    15 % or more and at least twice the fleet's median; then a chip on the
    early-lane card (D3), or a card of its own when the gap to the top 3 grew
    15 s or more over the shadowed stretches.
  - **D11 heel** (`heel.ts`): the boat's leeward heel (the tracker's roll,
    maneuvers blanked, as the Heel column) against the top 3's in matched
    2-minute windows on the same leg (same minutes, same breeze); the boats
    just ahead when the top 3 give fewer than 3 windows (medium at most, "no
    leader heel data"). A window needs 8+ heel fixes and roll over half of it
    for the boat and 2+ reference boats. The feed's roll is whole degrees, so
    only differences of 3° or more count, in 60 % of the leg's windows. Upwind
    it fires as *over-heeled* or *too flat* when, in those windows, the boat's
    VMG was 2 %+ below theirs ("Beat 2: you sailed ~4° more heeled than the
    top 3 and were 0.2 kt slower in VMG"); on runs (medium at most) as heeled
    to windward or rolling (heel's spread 2°+ above theirs). Seconds = the VMG
    deficit × those windows. Where D6/D7 fired on the same leg it is a chip on
    that card, not a second card; flatter-or-more-heeled *and faster* is a
    Went well line; level with the top 3 is a ✓. A heel chip on the leg story
    when it differed; in the Regatta view its themes ("Over-heeled upwind in 3
    of 5 races with good data") count only the races with heel data. No roll
    for the boat or its group (the J/105 CBC fixtures; older feeds): not
    evaluated. An uploaded .vkx log's heel is read at its full rate.
  - **Penalties.** An official code is a **penalty card** pinned above the
    ranked cards (`src/analysis/coach/penalty.ts`): never numbered, never a top-3
    slot, never in the seconds at stake. The code, its meaning in plain words, and
    what it cost: "Cost 3 places — 12th on the water, scored 15th" (IC37 NA R5,
    USA 016, DPI), "No places lost" at +0, or "Scored UFD — 16 points; the result
    is lost" ("You sailed on to 14th on the water" with a finish). The ranked cards
    then sit under "Smaller than the penalty: what cost time on the water". A
    scored OCS / UFD / BFD replaces the "Over early — cleared" card: its figures
    (over m at the gun, back +N s, recrossed +N s) are chips on the penalty card;
    an over-early boat scored AOK keeps the card. Ask Coach's context carries the
    penalty card and the Regatta view's Penalties row.
  - **D12 penalty turns** (`penaltyTurn.ts`, found in the worker from the raw
    fixes): course over ground from positions (thinned to 1 s and 2.5 m), the
    heading change integrated one way round, never across a hole (> 6 s) or an
    ambiguous step (> 135°); a run ends when the boat turns back 20° or pauses
    10 s, and splits wherever 8 s of it changes course under 20° (a tack and a
    gybe with straight sailing between are two maneuvers). 300° within 60 s is
    a 360, 660° within 120 s a 720; 6 heading samples per turn, ≥ 1.5 kn, never
    within 130 m of a mark, only from the boat's start crossing (never before the
    gun) to its finish. Seconds lost: its speed (mean over 30 s before) and course
    (the last 10 s before) carried through the loop and 15 s after it, against how
    far it got along that course. Medium confidence on the feed, high from an
    uploaded log. With an official code the turn rides on the penalty card ("720
    at 11:23:40 (+18 min), ≈ 45 s"); without one it is a ranked card ("Penalty
    turns (720)"), taken first: the start card's first minutes and the legs'
    rate findings give up the loop's stretch. Over 24 cached races (731 boats)
    it flags 11 loops, each a continuous one-way turn.
  - **D13 gate choice** (`gate.ts`, sides in `gateSides.ts`): at a leeward gate
    with both buoys tracked, the buoy each boat rounded, named looking upwind from
    the geometry (never the feed's gateLeft/gateRight: those are looking
    downwind): the nearer at its closest approach, when clearly nearer (≤ 0.6 of
    the other) with fixes ≤ 6 s apart around it. The wind at the gate is the
    fleet's tack bisector on the beat after it; the upper buoy is favored when it
    is ≥ max(10 m, 1.5 lengths) higher and worth ≥ 6 s (beat + run VMG), and
    confirmed when the boats rounding it were quicker from 150 m above the gate on
    the run to 300 m up the beat, by ≥ half that. The unfavored buoy, ≥ 5 s slower
    than the other side's boats rounding within 3 min, is a card ("Leeward gate:
    took the left mark (looking upwind) — 17 m further downwind, about 9 s on the
    beat. Boats rounding the right mark at the same time were 46 s quicker 300 m up
    the beat; you lost 10 places."); seconds = the side difference, high / medium
    (under 5 boats a side) / low (the wind moved 10°+ around the rounding). No card
    when the favored buoy was busy (3+ boats in the 20 s before, and they were no
    quicker), for a stop (1.6× the median passage) or a penalty turn in the
    passage; the next beat's side paying nets the cost ("net −12 s", or a ➕).
    The favored buoy and 2+ places gained is a Went well line. D9's sparse-data
    places at the same rounding ride on the card. "Gate L/R" on the legs table and
    the leg story; a gate-choice subtheme of the leeward roundings in the Regatta
    view. J/24 Nationals R2/R5 fire; J/111, IC37 and Melges 24 gates don't.
  - **D14 side of the course** (`side.ts`, the leg story's side as a card): on each
    beat and run the whole fleet is cut in thirds by its mean position across the
    wind; the paying third's mean places gained over the other's is the effect. A
    card when it is 3+ places and 2+ standard errors (the thirds' spread), over 5+
    boats a third, and the boat was in the losing third with its own position in
    the leg's middle third ("Right paid on Run 2: the right third of the fleet
    gained ~9 places on the left third; you were 455 m left of the fleet's
    middle"). Seconds = the effect × the fleet's seconds per place at the leg's
    end around the boat's place (as D9's sparse-data card reads places as time);
    medium under 10 boats a third. Without its own position: no card, only the
    leg story's side. In the paying third and gaining places: a Went well line.
    One card a race: the leg that cost the most seconds once the race's other
    findings have claimed theirs (a run D7 already holds keeps none), the other
    such legs on it ("Also on the side that didn't pay: Run 1, Beat 2"); one
    Went well line likewise ("(also Run 2)"). A "Side of the course" theme in
    the Regatta view, its seconds per race those of every leg on the card.
  - **D15 fast but going nowhere** (`nowhere.ts`): every boat's path on the leg
    read the same way (positions every 10 s, never across a hole over 15 s), so
    dense and sparse tracks compare like for like: SOG = distance ÷ time read, VMG =
    progress along the wind ÷ time read. A card when the boat was at least as fast
    as the fleet's median but 5 %+ lower in VMG, sailing 5 %+ more distance per
    meter made good, with half its leg read and 8+ boats to compare ("Fast but not
    climbing on Beat 2: 5.9 vs 5.7 kn, VMG 4.1 vs 4.4 kn, 44° vs fleet 40°");
    seconds = the VMG deficit × the leg time, like D6. As fast and 8 %+ better VMG
    on no longer a path is a Went well line. D6 / D7's ✓ leaves out a leg where
    the VMG and the path say the boat went nowhere, so "pointing" is never called
    fine against the distance sailed.
  - **D16 line bias** (`lineBias.ts`): with the start line 6°+ off square to the
    wind at the gun (at 6° the favored end is about a tenth of the line further
    upwind), each start is measured against the fleet's median start along the
    line (5+ boats with a position at the gun, not over early). The
    distance beyond the median toward the unfavored end × sin(bias) is the
    ground given away on the fleet, ÷ the fleet's VMG on Beat 1 the seconds.
    Beyond the median with 10 s or more given away: a start card ("Pin favored
    6° (~100 m over the line). You started 420 m toward the committee boat from
    the fleet's median start: ≈ 40 m upwind, about 18 s"), its confidence the
    wind's at the gun (so a medium-confidence wind needs 20 s); in the favored third and at or toward the favored end
    of the median: a Went well line ("Start: pin end favored 7° (~120 m) and
    you started 300 m toward the pin from the fleet's median start (≈ 36 m
    upwind)", seconds gained on the median); anywhere else, nothing. A fleet
    that mostly started at the unfavored end gives few cards: only boats well
    beyond it. Needs the boat's position at the gun (read, or estimated across
    a short hole); not for a boat over early. The Report's start section shows
    the line bias too.
  - **D17 maneuver cost** (`manoeuvreCost.ts`): each tack on a beat and gybe
    on a run (the legs table's detection) against the boat's own steady
    sailing just before it: the VMG over up to 25 s (at least 15 s) ending
    8 s before the head-to-wind (dead-downwind) crossing is the baseline; from
    there to 30 s after the crossing (40 s for a gybe) the ground it would
    have made at that VMG less what it made is the meters lost, ÷ the VMG the
    seconds. Only on dense fixes: no gap over 10 s across the whole stretch
    and a fix within 5 s of each end (a turn across a 5–10 s gap is measured;
    it only leaves the leg's count untrusted). The steady window starts 20 s
    after the previous maneuver and 30 s into the leg (back to full speed:
    the median tack is at 99% of its VMG 15–20 s after the crossing, the
    median beat level 30 s after a leeward rounding), with no other
    maneuver before the recovery's end, at a baseline VMG of 0.5 m/s or
    more, ending 15 s before the next rounding. A run's gybe-set is the
    rounding's (the leg story's window: up to 30 s after first sailing
    downwind, past an offset mark), never counted or measured as a gybe of
    the run, for any boat. Per leg the boat's measured turns (3+, or 2
    against 10+ other boats measured, each of the two then judged) against
    the fleet's: one median per other boat (5+ boats, 10+ maneuvers), the
    fleet's figure the median of those; and its count against the fleet's
    median count where both counts are trusted (80 %+ of the leg tracked,
    none across a gap). Only what was measured is charged: extra meters =
    the sum over the measured turns of (meters − the fleet's) + (with many
    more turns than the fleet) the extra count × the fleet's meters a turn.
    A card when that is 25 m or 10 s or more and the median is costly (1.3×
    the fleet's, 4 m more, and 2 standard errors more: one maneuver's meters
    swing with the puffs, so the difference is judged against the boat's
    turn-to-turn spread over its measured and the spread of the boats'
    medians over the boats) or the count is well above the fleet's (2 more
    and 1.5×) ("Costly tacks on Beat 2: your tacks cost ~17 m each (~7 s),
    the fleet's ~5 m: ~36 m lost on the fleet over the 3 of 6 measured"; a
    count says "You tacked 9 times, the fleet 5 times: 4 extra × the fleet's
    ~5 m a tack = ~20 m"). Seconds = extra meters ÷ the boat's VMG; the
    card's window is the measured turns' own stretches, so a rate finding on
    the leg (D6, D15) gives up only those. Confidence: the coverage of those
    stretches (and the leg's, for a count), the fleet's boats with 3+
    measured, the wind; medium under 5 measured, which needs 10 s (not 20 s:
    measured turn by turn, its own test stands for the noise). The ⚠ chip
    says "few maneuvers measured" or "few boats measured". One card a race
    per kind of maneuver (the leg that cost the most, the others on it as
    "Also on …"). A median 0.7× the fleet's or better (4 m and 2 standard
    errors less) worth 10 s or more over the measured is a Went well line
    ("Beat 2: tacks ~0 m each vs fleet ~14 m (3 measured)"). The Report's
    legs table adds the measured cost to the tacks / gybes against the
    selected group's, 5+ of its boats measured ("6 tacks · ~17 m each (fleet
    ~5)", "(group ~5)"; never against the top 3); a "Tacks and gybes" theme in
    the Regatta view. The public feed is bursty, so it is quiet there: on
    Cascais J/70 R2, the whole feed, 282 turns are measured fleet-wide but
    no leg has a costly enough one, so no card; on the committed fixtures
    one finding (J/24 R2) and two Went well lines. An uploaded log measures
    every maneuver.
  - **Regatta view, Penalties:** a row above the pattern cards, one line per code
    ("DPI in 8 of 8 races · 24 penalty points · ≈ 24 places", "UFD in 1 of 8 races
    (R3) · 16 points; result lost") and penalty turns ("Penalty turns in 2 of 8
    races · ≈ 70 s"). A penalty is never a theme, a pattern card or a thing to
    work on; the place row shows the code with its points and the on-water place.
  - An **uploaded .vkx log** feeds the Coach at its full rate: the analysis
    track is thinned to 1 Hz (merge.ts), but the boat keeps the log's own fixes
    (`Boat.fullRate`) and the worker hands the Coach every boat's raw fixes
    within 130 m of a mark (`zoneTracks`, the uploaded boat at 10 Hz, the feed's
    at most every 0.4 s). Leaders are only used where their own fixes pass the
    gate.
  - **Regatta denominators:** dirty air, each kind of rounding, and heel count only the
    races the detector had the data to measure ("3 of 4*" in the table, with a
    footnote); everything else counts every race with enough tracker data.
  - **Leg by leg:** places are in the whole fleet, out of a fixed fleet (every
    boat that started; the official fleet when linked) on every leg: "gained 3 ·
    12th of 33", "lost 5 · 30th of 33", "even · 4th of 33". A boat with no time
    at a mark (a tracker hole, a dropped tracker) is placed from a time
    interpolated between its roundings either side (or its finish) along the
    fleet's median splits, or carried on at its own pace (estimated inside, shown plainly).
    A finish lost in a hole is placed among the finishers by its estimated
    time; a boat that finished with a code (DPI…) at its on-water place; coded
    boats that didn't (DNF…) after the last finisher. The start: every boat on
    the line by its place at the gun, the start place's order kept and a boat
    whose DTL falls in a hole placed between from its nearest fix (dead reckoning
    when one is within 10 s, else interpolation when fixes within 30 s bracket
    the gun; shown plainly); over early or away from the line after them; with neither,
    its start place is unknown ("— · 20th of 100") and it is left out of Beat 1's
    places gained and movers. Against Top 3 / Near /
    custom the closed row adds the leg's seconds against the group's median leg
    time ("lost 12 s vs Top 3") instead of a place within a handful of boats.
    Side: positions every 30 s, read across holes up to 60 s with a fix within
    30 s, a third of the reads needed (the bursty public feed left runs with no
    verdict at 15 s / half). Gybe-set: a gybe from 5 s before the windward mark
    to 30 s after the boat first sails downwind (|TWA| ≥ 120°, looked for up to
    60 s): past an offset mark's reach the set is at the offset (Cascais R2 Run 1:
    17 gybe-setters, +14 places vs −4 for the bear-aways; 1 with the old 30 s
    from the mark), on a plain windward mark the same 30 s as before.
- **Impossible leg splits** (`analysis/legs.ts` `legSplitOk`): a leg faster than
  max(25 kn, 3× the fleet's median SOG or VMG for it), or sailed in under 0.3 of the
  fleet's median time, is unknown (—) everywhere: the legs table, the fastest
  leg, the movers, the Coach (a rounding timed off a position glitch or a second
  device on the sail: Cascais R3 FRA 1089 Beat 2 in 19 s at a VMG of 380 kn).
- **Report** (`src/ui/report.ts`, `src/ui/reportView.ts`): the **Report** button
  (top right of the race header), `#report` or `report=1` opens one printable page
  for the selected boat in the race: the header (place on the water and scored,
  with any code; race, official elapsed and corrected times; the estimated wind
  and where it came from, the tacks 0:30–3:30 after the gun or the first beat's),
  the start (distance and seconds late at the gun, start place,
  the line bias, line position, place over the line and front row, over early and when it
  cleared, the start card), leg by leg (places in → out of the fixed fleet, time
  against the Coach's group, SOG and VMG against the group's median, tacks /
  gybes with D17's measured cost a maneuver, side, gate buoy), roundings and gates (D9 / D13), penalties (the
  code, penalty turns), and the Coach's penalty card, ranked findings (its order
  and seconds), Went well and the cards' tips as things to work on; a small track
  map. Only figures Recall already works out: anything it can't show is `—` with a
  short note. Built from the Coach's own model,
  debrief and group, only while open. With the Coach's view on Regatta
  (`cview=regatta`) it is the regatta version: a line per race, penalties, the top
  3 to work on, Went well and legs by type. **Print / Save PDF** prints it alone,
  light, on one A4 or Letter page. Never owner or crew names.

Each table stays on the tab with the charts it's read against, because
picking a boat in a chart and finding its row (or the reverse) is the main
way they're used; a separate Tables tab would split every such pair. The tabs
are a tablist (arrow keys, Home / End) that sticks under the boat strip on a
phone. The tab is in the URL hash (`#start`, `#race`, `#coach`; replaced, never added to
history) and kept with the last race viewed. A hash on the URL wins; a link
without one opens Start, or the saved tab when it reopens the saved race.
Switching races keeps the tab.

- **Start View - Gun:** each boat's bow (GPS tracker + class bow offset)
  against the line with a 60 s trail (`START_TRAIL_MS`) shifted so it ends on
  that bow, arrows along course over ground, plus the line length and bias and
  which end was favored. Wind bearings display as 0° rather than 360°.
  Hulls are drawn to scale when the class is known (division `boatClass`,
  then division name, then the event's class label; e.g. Cape 31 = C31,
  9.55 m); otherwise the key line says `hulls not to scale` (and the ⓘ why).
  The line continues dashed past each end, and the favored end is labeled
  with its bias in degrees and meters (and boat lengths when the class is
  known), e.g. `Pin favored 7° · 18 m (1.9 lengths)`, or `Square line`
  within 2 m. The label is small text running along the favored end's
  dashed extension, starting a clear gap past the pin or RC mark and sitting
  just above the line: "above" is screen-up once the text is turned upright
  (it flips 180° rather than read upside down), which with the wind at the
  top is the course side, away from the boats. It scales with the view like
  the boat names, so it reads the same at every zoom. It always takes the
  longest wording that fits on the extension and keeps the meters:
  `Pin favored 7° · 18 m (1.9 lengths)`, then `Pin favored 7° · 18 m`,
  `Pin fav. 7° · 18 m`, `Pin 7° · 18 m`. The Fit view leaves room past the
  favored end for one of those: `Pin favored 7° · 18 m` on a wide chart
  (the frame grows up to 25%), and on a chart under 480 px wide, where the
  text is larger, the longest that fits with the frame grown up to 35% (that
  frame changes only when the chart crosses 480 px). The lengths join when
  zoomed in. Only if none fits does the label run along the line inward from
  that end (as `Pin 7°` at worst). `Square line` sits centered along the line.
  The wind chip (`wind est.`, `model wind`) and the label's tooltip say in
  plain words where the wind comes from and how sure it is ("Wind about 220°
  at the gun, estimated from how the fleet tacked in the first few minutes.
  Medium confidence."); low confidence is a ⚠ chip. The ⓘ says how far 5° of
  wind moves the figure. `Names: Auto | All | Off` sets the
  boat labels: Auto places them greedily (selected boat, then by start place)
  and leaves out any that would overlap another label or the line, so
  zooming in reveals more; hover or tap a boat for its name either way.
- **Start Playback** (`ui/laneSnapshots.ts`, drawn by
  `ui/laneSnapshotsView.ts`): a section under the start chart, open by
  default (collapsible), kept as a view of its own (not merged into the
  start chart). One map at the panel's full width (on a phone too) shows the
  fleet at any second from gun −1:30 to gun +3:00, so a coach can see how
  each boat set up, came off the line and whether it held its lane. A time
  slider (`<input type="range">`, −90 to 180 s, 1 s steps; full width, on
  its own row on a phone) moves it, with ‹ › (∓1 s) and a play / pause
  button (one second every 100 ms, 10× real time; it stops at +3:00, starts
  again from −1:30 when pressed there, and never starts by itself, except
  from "Replay start →" below). With focus in the section, ← → step 1 s,
  Shift+← → 10 s, Home / End go to −1:30 / +3:00; all clamped (‹ is disabled
  at −1:30, › at +3:00). Buttons are 44 px tap targets. The time
  (`gun −1:12`, `gun +0:45`) heads the map and is the slider's spoken value.
  It opens at the gun (0:00) and keeps the second picked across redraws (a
  new boat, say) for the session. Every boat's position and course on the
  1 s grid and its trail points are worked out once per race and selection;
  scrubbing only redraws the map. Each second draws every boat with the
  Race Viewer's fading trail, its last 2 minutes (never before gun −1:30,
  or where the data starts), and the start line.
- **Boat shapes** (`ui/boatShape.ts` `boatMark`): Start Playback and the
  Race Viewer while scrubbing or replaying draw each boat as the start
  chart's hull, centered on its position and pointing along its course over
  ground at that moment (the scrubber's: the step between the fixes either
  side), or, while it is held past its final fix, slower than 1 kn or has no
  course, along the last heading it had. It
  is to scale from the class's length and beam once that is at least 12 px
  long on screen (`BOAT_SHAPE_PX`; 15 px for the selected boat), else a
  symbol that long with the hull's proportions (as the start chart's
  markers when its hulls would be too small). It is filled while the boat
  has data and hollow (a quiet outline in its own color) once its tracker has
  stopped for good (held past its final fix, before its finish), so a dropout
  never flips the hull to a dot. Across a hole in its track, however long, the
  boat glides along the filled-in path as a normal filled hull (see Data
  gaps on the maps). The boat
  is a dot only when no heading was ever known (no step yet of at least
  1 kn, `BOAT_SHAPE_MIN_KN`), the class has no dimensions, or the map is
  zoomed out so far the hull to scale would be under 1.5 px
  (`BOAT_SHAPE_MIN_PX`: the symbol would overstate it over 8× and a close
  fleet would run together; zoom in for shapes); that dot is filled or
  hollow by the same rule. Sail-number labels, the selection, the
  comparison rings, the over-early styling and the map's colors (by leg,
  rank or boat speed) are the same filled or hollow.
- **Start Playback: zoom.** The map pans and zooms as the track map does
  (`ui/panzoom.ts`: pinch, drag, double-tap, Ctrl/⌘ + wheel, + / − / 0 with
  the map focused, and the same Fit / 2× / 4× / 8× buttons). Fit, the
  default and what Fit and 0 reset to, is fixed for the whole slider (it
  never rescales while scrubbing, and scrubbing or play never change the
  zoom level): the line's ends and every position at every second −90 to 180 s
  and every trail point to +3:00, padded 8% each way (at least 10 m).
  Nothing else is added. The only guard leaves points out (it never pads):
  boats away from the line, and points more than 3× the line's length (at
  least 400 m) from its middle, so one stray boat can't blow the view up.
  With the map zoomed in, its arrow keys pan; at Fit they step the slider.
  See **Map zoom: centering and follow** for where the buttons zoom to.
  The map keeps that extent's aspect, full width, its height capped on a
  desktop (60vh, 560 px; 70vh on a phone) and centered. Text (sail labels
  13 / 12 px), dots and strokes stay the same size on screen at any map
  size and zoom: strokes are non-scaling, and text and dots are sized from
  the map's measured px per meter times the zoom (re-measured on resize).
  The true wind is a small badge over the map's top-right corner, outside
  the map: an arrow pointing downwind and the TWD with its source
  (`TWD ~18° est.` from the fleet's tacks, `TWD 18° (model)`, `TWD ~18°
  assumed` from the course). The wind is at the top (the analysis's wind
  at the gun, as the start chart), so the arrow points straight down. With
  no wind estimate the view is north up and the wind is assumed square to
  the line, blowing from the course side (`Wind assumed ⟂ line`, a dashed
  arrow turned that way). No mark is drawn. The selected boat and its Coach
  group (Top 3 by default) are highlighted and labeled, the rest faded.
  Positions are the Race Viewer's: between the fixes either side, on the
  filled-in curve across a hole of any length; after its final fix when its tracker stops
  before it finishes, held there (hollow after the first 30 s) for up to 2 minutes,
  else the boat is missing at that second (never placed before its first fix or
  invented after its last); trails run on across holes. A boat within 1 s of a fix
  where the scrubber has no position (its feed starting or ending) is placed at that fix. The caption is just the selected
  boat's place upwind among the boats placed (`USA 016: ≈ 6 of 15`: an
  approximate ranking by distance made from the line's middle along the
  wind, or along the line's perpendicular when the wind is assumed), or its
  one note (`no position at this time.` / `not tracked.`); a second with
  no positions and no trails says `No tracks at this time.`
- **Start Playback: over early.** A boat over early (the over-early facts
  from the worker, as the track map's "Replay start") is drawn as that
  replay draws it, from the same helper (`ui/ocsStyle.ts`): its track over
  the line in red on a light casing, its dip back dashed red until it
  recrossed, a hollow red ring where it went back and a red dot where it
  cleared, each once reached; never faded with the boat. Its tooltip says
  so (`USA 019, over early (OCS), cleared +35 s`). The key line says who is
  highlighted and where the wind comes from; when any boat was over early
  it adds a legend (`Over early`, `Going back`, `Back`, `Cleared`, drawn as
  on the map). The Start tab's `Replay start → USA 019` buttons (under the
  start chart) select that boat, open this section, scroll to it, set the
  slider 5 s before its track went over (never later than gun −0:10, never
  before −1:30) and play it from there; with reduced motion they leave it
  paused there, the play button focused. The track map's own `Replay start`
  (Race tab) and `replay=` deep links still replay on the map. The map's
  screen-reader label is short: `Fleet at gun +1:00: 15 of 15 boats placed.
  USA 016: ≈ 6 of 15 upwind. True wind from 18° (estimated).`; the same is
  said through a polite live region 0.7 s after the slider settles (not on
  every second while dragging). Nothing is worked out while the section is
  collapsed or the Start tab is not showing, and play stops when either
  happens.
- **Key lines** (`ui/info.ts`, `ui/captions.ts`): under every chart and
  table, one short row of chips with the key facts only, e.g.
  `Line 143 m · RC fav. 2° · 4 m · wind est. · hulls to scale`,
  plus legend swatches (`○ estimated mark`, `- - not racing`,
  `● crossed the line`). Caveats stay in sight as
  red ⚠ chips: low wind confidence (`⚠ wind est. low`, `⚠ wind assumed`),
  Vakaros vs our check, unchecked OCS, a start
  window cut short, legs split from the fleet's turns (on the Race Analysis
  card). Nothing on screen flags a hole in a track (see Data gaps on the
  maps). At the gun, where a boat's own fixes have a hole across the start
  sample, the Vakaros device's distance is the start figure when it reported
  one (ranking, away from the line, the Coach's start inputs, the over-early
  replay); without one, our figure interpolated across the hole is shown like
  any other (the start table's check and Late, the start chart's bow number),
  with no `~`, chip or note. The row ends in one ⓘ
  "How to read this" (a native `<details>`, closed by default; it stays
  open across redraws) with a few short bullets: methods, what dashed
  means, sensitivity (5° of wind moves the favored end N m), label meaning, Names modes,
  gestures, and for the start table each boat's start caveats. Full screen
  shows the same key line.
- **Map zoom: centering and follow** (the Start Playback map and the track
  map: gestures in `ui/panzoom.ts`, views in `ui/view.ts`, the follow camera
  in `ui/follow.ts`). The 2× / 4× / 8× buttons
  and + / − center on the selected boat where it is at the moment shown
  (the slider's second, or the scrubber's time), with the follow camera's
  look-ahead below; with no boat selected, or
  the selected boat not placed then (before its first fix or after its last), on the middle of the
  fleet's positions (their bounding box's center); with nobody placed, on
  the map's center. The track map with no moment (the full race) keeps the
  view's center. Fit and 0 show the whole default extent. Pinch, double-tap
  and the wheel zoom toward the fingers or the pointer: Ctrl/⌘ + wheel (a
  trackpad pinch) always, a plain wheel only once the map has focus (click
  or tab into it), and never past Fit or 16×, so scrolling the page over a
  map isn't caught. Zoomed in, scrubbing and play follow the selected boat
  with a look-ahead camera (`ui/follow.ts`): the view leads along the boat's
  course (the circular mean over the last 18 s), so upwind (|TWA| ≤ 70°
  from the map's wind estimate) the boat sits about a third of the way in
  from the trailing edge, with the boats ahead in view; downwind (|TWA| ≥
  115°) it sits just forward of center, showing the boats astern (on its
  wind); reaching, or with no wind estimate, a modest lead. The lead is a
  share of the view, so it looks the same at 2×, 4× or 8×; it eases in over
  a steady stretch and back toward center through a tack, gybe or rounding,
  and the camera eases with a critically damped spring (race time, so the
  same played or stepped). A slider jump of over 15 s, a newly selected boat
  or `prefers-reduced-motion` snaps instead. The zoom never changes.
  Panning by hand (drag, double-tap, arrow keys) stops the follow until a
  zoom button, + / −, 0 or Fit is used again (a double-tap at 16× goes back
  to Fit, still with the follow off); a wheel or pinch zoom keeps
  it; selecting a boat (on any view) starts it; a replay or a Coach card's
  window framing the track map stops it. A boat selected at Fit is snapped
  to on the first zoom in. On the track map the camera's pans move only the
  SVG's viewBox (with the scale bar and wind arrow), never a full redraw
  per frame: line widths and text follow the zoom level alone, so the map
  is redrawn only when the zoom changes, and once after a pause
  (`ui/mapPaint.ts`). Sail numbers sit a few px off
  their hull, abeam (clear of the boat's own track), at any zoom.
- **Zoom hint:** "Pinch to zoom · drag to pan · double-tap to zoom in"
  shows under the start chart on touch devices only (`(pointer: coarse)`),
  until it's dismissed with × or by the first pinch, pan or double-tap; the
  dismissal is kept in `recall.hints` (`ui/hints.ts`; blocked storage just
  shows it again next visit). Desktop gestures are in the start chart's ⓘ.
- **Full screen** (`ui/fullscreen.ts`): the expand button at the top right
  of the start chart, the track map and the Rounding & Finish Positions cards opens that
  chart over the whole viewport, with its own controls in a compact top bar
  (start chart: Fit / 2× / 4× / 8×, Color, Names; map: the leg picker and
  Color) and its key (the speed scale, or each boat's color for a fleet of
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
  for the names and the favored-end label, then grows to the screen's own
  aspect, so the fleet fills the width. The spare height always goes below
  the line, to the trails (the line sits near the top under just its margin
  for names, PIN/RC and the wind arrow). Text stays ~10 px at any size, so a
  big screen draws the hulls to scale. Inline, Fit also takes in every trail
  near the line and the chart keeps that frame's aspect, so a long line on a
  phone is a thin strip (a 500 m line is ~0.5 px per meter at 390 px); in
  landscape full screen the same start is drawn about 2.5× larger. In
  portrait, a wide start shows a dismissible "Rotate to landscape for a
  bigger view" (the orientation is never forced); the chart is redrawn on
  every resize or rotation. The Rounding & Finish Positions chart fits the overlay's
  height when that leaves each row at least 12 px (growing a small fleet's
  rows up to 32 px); otherwise it keeps its usual rows and scrolls inside
  the overlay. On closing, the page's scroll position and focus on the
  expand button are restored once the browser has left native fullscreen
  (Chrome resets both on its way out), and again on the next frame.
- **Start Speed Control** (Start tab, after the start chart;
  `analysis/startSog.ts`, `ui/startSog.ts`): each racing boat's speed over
  ground (the same 4 s mean the speed-colored tracks use) against seconds
  from the gun, with the gun as a dashed line. `Window: 30 s | 60 s | 120 s`
  sets how far before the gun it starts (it always runs to +20 s; remembered
  in `recall.startSogWindow`, default 60). The analysis keeps every fix from
  120 s before the gun to 20 s after, and the live feed is fetched from 130 s
  before the gun to allow for it; if no boat's track goes back as far as the
  window, the chart starts at the earliest data and a ⚠ chip says so.
  Each boat is one line through all its fixes: where they are more than 5 s
  apart (a hole) the line runs straight on between them, drawn as the rest,
  and hovering there reads that line. A dot
  marks where each boat crossed the line (the start table's Late) and its
  speed then ("crossed +2.6 s at 5.3 kn"). Hover or tap for the speed under
  the pointer (the selected boat's, else the nearest line's) with a
  crosshair; tap a line to select the boat. Not racing boats are left out.
- **Start by boat** (Start tab, a table after the start charts): finish
  place, start place, distance off the line at the gun (Vakaros and our
  check, bow-corrected), seconds late, line position (0% pin … 100% RC),
  speed at the gun, TWA at the gun and heel at the gun, with each boat's start
  caveats listed under it.
- **Performance Metrics** (Race tab, a table after the map, Rounding & Finish Positions and Race Analysis): finish place,
  start place, then per leg VMG, SOG, TWA, heel, distance sailed (meters), leg time
  with the place at the mark, and tacks (on beats) or gybes (on runs; both on
  reaches); then the same for **Upwind** and **Downwind**, then the
  race: distance, race and finish time, average SOG, tacks and gybes.
  Distances are whole meters with a thin-space thousands separator
  (`12 345`). Distance sums the GPS track point to point. Every figure is
  shown plainly, one across a hole in the track too (a distance, a tack or
  gybe count or a leg time there is flagged inside, `distGapS`,
  `manoeuvreGap`, `timeGapS`, where the analysis needs it, never on screen);
  a leg with no timed rounding shows — (see Legs below). There is no Data %
  column and no low-data flag.
- **Rounding & Finish Positions** (Race tab, after the track map; `analysis/places.ts`,
  `ui/places.ts`): a bump chart of each boat's place at the start, at every
  mark rounding (named as the legs name them; a repeat is "M1 (2)") and at
  the finish, 1 at the top. Start is the start table's place among clean
  starters (an OCS boat, or one with no reliable figure, has no start
  point); each mark is the order of the rounding times from the leg splits
  (a leg's end, or the next leg's start when that leg broke), among the boats
  with a time there, with equal times kept in the legs table's order; Finish
  is the finish order. A boat with no rounding time at a mark is left out of
  that mark's order, so the others close up, and its line
  is dashed gray across it; nothing is guessed. A DNF's line stops at the
  last mark reached and is labeled "DNF" there. Boats set aside as not
  racing are not drawn. When the legs come from where the fleet turned (no
  mark trackers) the marks are those turns; a one-leg race is Start → Finish.
  Lines use the boat colors (past eight boats the colors repeat; the
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
  (ties share a place). A boat missing one gets a partial sum, shown in gray
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
  or rounding up at a mark on the same side is not a maneuver; a gybe-set or
  a tack around a mark is, and within 15 s of the rounding it is counted on
  the leg it belongs to (a gybe on the run, a tack on the beat). A side change
  across a telemetry hole (> 5 s) is counted, flagged approximate inside (not on screen).
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
  nearest the gun within 2 s. Readings of ±90° or more (a sensor
  clamp on coach and spare trackers) and runs of exactly 0° roll and 0° pitch
  lasting 10 s or more while moving (a device sending no IMU) count as
  missing; brief 0/0 readings are real and kept. Feeds without `roll` (older
  events) hide the heel columns and say so in the tables' ⓘ. Trim (`pitch`)
  is read and averaged per leg but not shown: it carries each tracker's own
  mounting angle (boats in one fleet sit 13° apart on every leg), so it
  doesn't compare between boats.
  With no fixes for minutes at a time, maneuvers inside the hole can't be
  seen at all.
- **Data coverage** (internal): the share of each leg (and of the race) where
  the boat's fixes are at most 5 s apart, and the longest interval between
  fixes. The public feed is lossy: some events have holes of several minutes.
  The Coach's confidence and gates read it (a card on thin data is low
  confidence or not judged, never made up from an interpolated stretch); it is
  not shown as a figure, a flag or a note anywhere.
- **Sorting:** every column header sorts its table, best end first; click
  again to reverse. Missing values always sort last. The two tables sort
  independently, and both sorts are kept with the last race viewed (a sort
  saved before the split goes back onto whichever table has that column).
- **Rank:** once a table is sorted, a narrow Rank column (leftmost, pinned)
  gives each boat's place in that sort, 1 at the top in either direction;
  ties share a place ("=3", then 5) when the shown (rounded) figures match,
  a missing value or a not-racing boat shows "—". Its header names the
  sorted column in short ("Up VMG", "B1 SOG", "Race Time"). In finish
  order (no sort) it is hidden: Fin already gives that order, and a phone
  keeps the width.
- **Race Viewer** (the Race tab's map; it was "Tracks by leg"): a map in
  local meters (no map tiles), rotated so the wind comes from the top. The
  legend picks one leg and zooms the map to it. With the time slider on,
  each boat leaves a trail of its last 2 minutes (`BOAT_TRAIL_MS` in
  `ui/trail.ts`; the `Trail` buttons pick 30 s or 2 min, the default, or
  `All` / a Coach card's `Window` for the tracks themselves). The trail is
  in the boat's own color (its leg, rank or speed color, dimmed with it when
  another boat is selected) and fades toward the tail in four steps
  (`TRAIL_FADE`). It never breaks: a hole in the track, however long, is
  filled in and drawn as the rest (see Data gaps on the maps). Each frame only
  updates the trails' path data (`ui/trailLayer.ts`); the map is never
  redrawn for it during play. A boat in a hole glides across it on the
  filled-in path, a normal filled hull. A tracker that stops
  for good is held after its final fix (`boatAt`'s `endHold`) for up to
  2 minutes (`MAP_HOLD_S`), filled for
  `BOAT_STALE_MS` (30 s) and then hollow, but never past
  the boat's finish: a boat that finished leaves the map at its finish as
  before rather than showing as lost. A replay's over-the-line overlay has
  its own layer (`g.scrub-ocs`) over the trails.
- **Data gaps: none shown** (`ui/gapFill.ts`, display only). As RaceSense's
  and Vakaros's own viewers do, Recall shows no data gaps anywhere: every hole
  in a boat's track is bridged silently wherever the track is drawn, whatever
  its length, accepting that a long bridge is a guess. Holes are judged on
  the feed's own fixes, not on the drawn segments thinned to one fix a second
  (thinning turns a 1.5 s hole in a 2 Hz feed into a 2.5 s step). A hole is a
  step between the feed's fixes over 2 s, or twice its usual step
  (`analysis/rawHoles.ts`); each drawing carries the fixes around every hole
  (`BoatDrawing.holes`, display data that no result reads), merged back into
  the thinned segments for drawing. Every hole is filled in with a smooth
  curve: a cubic Hermite from the fixes either side and their velocities
  (course from the neighboring step, at the fix's SOG), Catmull-Rom where
  those are missing, straight where a tangent points back or the curve would
  swing wide; sampled about every second. A hole where one leg's track ends
  and the next begins (a rounding inside it) is bridged too
  (`mapPieces.ts` `filledRanges`). The filled stretch is drawn exactly as the
  rest of the track (no lighter opacity, no dashes, no breaks) in the Race
  Viewer's tracks, trails and Boat speed colors, the start chart's trails,
  Start Playback, the Coach card maps and the landing page's hero; its points
  read like any other in the hover tooltip; and the boat glides along it
  (position and heading between the fixes either side), a normal filled hull.
  Before a boat's first fix and after its last nothing is invented. The
  charts do the same: Gap to rivals' lines, Start Speed Control's speeds and
  the Rounding & Finish Positions lines run straight on across a stretch
  without values, and no chip, key swatch, tooltip, table mark (`~`), note or
  Coach card names a gap, a hole, missing data or interpolation; at the gun the
  Vakaros device's distance is the start figure where it has one, else ours
  across the hole, shown plainly. On C31 Gold Cup race 2 (two fleet-wide
  blackouts, 13:16–13:24 and 13:37–13:44 UTC) the share of boat-time drawn
  blank went from 46% (and 29% lighter) to 0, and on race 10 around the gun
  (ITA 78's 31.7 s hole) from 1% to 0. The bad data the filters drop (fixes
  far off the fleet, a replayed tracker, SOG spikes, the start chart's
  off-scale boats with their `▲ off scale` caret) is not a gap and stays
  dropped. The filled points are drawn and nothing else: the results,
  finishes, OCS, start-line crossings, penalties, places, coverage and every
  Coach number read the real fixes only, with their own hole rules
  (`tests/gapFillDisplayOnly.test.ts`), and the Coach makes no finding from a
  bridged stretch.
- **Color tracks:** `Color: Leg | Rank | Boat speed` beside the legend.
  Rank is the elapsed-time scale (reversed plasma: yellow = fastest, through
  orange and magenta to purple = slowest). Rank also sets opacity and width:
  the top 3 bold and on top, the rest of the top quartile strong, the slower
  half faint; gray dashed = didn't complete. On one leg it ranks that leg; on
  the whole race it ranks each leg's segment on that leg, or the whole track
  by race time (`Rank by: Overall`). `Highlight: Top 3 / Top 10` grays out
  everyone else and spreads the colors over just those. Boat speed shades
  every stretch of track by that boat's own speed over ground (4 s mean,
  viridis: dark purple slow, through teal, to yellow-green fast; a hole
  colored on across, as the track is drawn). The scale is the fleet's 5th–95th percentile. On the
  whole race, `Scale: Per leg` (the default) stretches colors over each
  leg's own spread so beats aren't all dark next to planing runs; `Whole
  race` uses one knot range for every leg. Hover a track for the boat, local
  time, SOG and leg. The start chart has its own `Color: Boat | Speed`:
  Speed paints the 60 s trails and the hulls (SOG at the gun). Selecting a
  boat draws it bold. A picked coach or spare stays gray and dashed and is
  left out of the scale. The choices (and the start chart's `Names`) are
  remembered in this browser.
- **Findings:** plain-English notes, split in two. **Start findings** sit
  under the start chart: the favored end (in degrees and meters), the best
  start beside the worst, and boats over the line or that race control
  couldn't check. Best and worst are the first and last clean starters by
  start place (one boat each, no ties); boats over early or away from the line
  are left out of both (they have their own lines, and a small note says so).
  The two sit in a small table with the same rows for each: `Behind the line
  at the gun`, `Late`, `Speed at the gun` and `Line position` (% from the
  pin); with one clean starter only the best shows. The finding's text keeps
  a plain-text form of the same. A boat over the line but not flagged reads
  `#USA 019 (Balthasar) was over 2.3 m by Vakaros DTL (not flagged OCS)`
  (`by our track estimate` when the figure is ours; the boat name, never a
  person's).
  **Race Analysis** (Race tab) follows Rounding & Finish Positions: the biggest single-leg gain and
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

## How the Coach ranks cards

`src/analysis/coach/rank.ts`, with the weights and caps in `opportunity.ts`.
A race's cards are ordered by their **impact on the result**, so the first card
is the thing that cost the most:

```
impact = W[confidence] × min(seconds, CAP[confidence])
W   = high 1, medium 0.7, low 0.4                       (CONF_WEIGHT)
CAP = high ∞, medium ∞, low 60 s                        (IMPACT_CAP_S; LOW_IMPACT_CAP_S = 2 × the low minimum)
```

- **Seconds are the one currency.** Time lost anywhere adds up at the finish;
  places don't (5 places lost in a pack at the first mark are not 5 places at
  the finish). Every detector reports seconds lost; the ones that measure
  places turn them into seconds where they were lost: D14 by the fleet's
  seconds per place at the leg's end around the boat's place, D9's
  sparse-data card by the chart's gap change to the boats that passed it, D13
  by the time against the boats rounding the other buoy at the same time.
- **A gap card's seconds are the chart's.** D3, D4, D5, D8, D10, D9's sparse-data
  card and the Went well legs read the Gap-to-rivals chart's own points
  (`timeGap.ts` `groupGap`: time at equal course progress, every 10 s from the
  gun), with the card's boats as the group: the seconds are the chart's change
  between the two points the card names (`Opportunity.gaps`), never another
  gap. Where a higher card already holds part of its window (below), the card
  shows less than that change. Who passed whom at a mark (D9) and the leg table's places
  stay a same-moment ranking: a place is a moment's order, not a time.
- **Confidence discounts, and caps.** A medium card counts 0.7 of its seconds,
  a low one 0.4. A low-confidence estimate leans on interpolation across
  holes, and that error grows with the hole, not with what was lost: its
  seconds count up to 60 s only, so a low card scores at most 24 and never
  outranks a high card of 24 s or more or a medium of 35 s or more. The card
  still shows all its seconds. Two cards tied on impact (two low cards at the
  cap) go by the more seconds, then the earlier window.
- **Each race-second is claimed once.** Moments go first: penalty turns (D12)
  and the gate choice (D13) claim their stretches before anything else, and
  the start's window (D1, D3, D16) is taken out of the rate findings' spans
  (D6, D7, D11, D14, D15, D17) with their seconds pro rata. Then, highest
  impact first, each card keeps what is left of its window; a later card loses
  the share of its window already held, and its impact is worked out again on
  what it keeps.
- **Minimums by confidence**: a card shows only with 10 s or more at high
  confidence (4 s for D1, measured off the crossings), 20 s at medium (10 s
  for D17, measured turn by turn), 30 s at low; none is never a card.
- **The top 3**: at most 2 from one detector (MAX_PER_KIND; penalty turns
  exempt): a third is passed over before it claims any seconds and the next
  card of another detector takes the slot. The side of the course (D14) is one
  card a race, D17 one a kind of maneuver, before ranking. Shown in impact
  order: a penalty turn is taken first but shows where its impact puts it. An
  official code (OCS, DPI, …) is the penalty card, pinned above the ranked
  ones. The Regatta view ranks the same way, uncapped.

## Data sources & caveats

| Endpoint | Used for | How |
|---|---|---|
| `racesense.vakaros.com/api/landing` | event list | via our `/api` proxy (no CORS upstream) |
| `racesense.vakaros.com/api/regatta?event=` | divisions, entries, course & mark trackers, gun time, start line at the gun, OCS, race-control DTL, finishes | via `/api` proxy |
| `racesense.vakaros.com/api/wind?v=3&…` | modeled wind, used only to cross-check | via `/api` proxy |
| `teleapi.regatta.app/telemetry/event/{id}` | ~5 Hz GPS tracks for boats and marks, with heel (`roll`) and trim (`pitch`), and each device's `race_number` / `race_stage` | via `/api/telemetry/event/{id}` (same-origin proxy; one race window, paginated with `after`; the division as the feed tags it, spaces as `_` and dots as `//`: "Female 7.5" is `Female_7//5`) |
| `api.yachtscoring.com/v1/public/…` | official race numbers, places, codes and (if plausible) finish times | via `/api/ys/…` (allowlisted, owner/crew fields stripped, edge-cached) |

- **Unofficial.** These are public but undocumented feeds, read anonymously,
  and they may change without notice. Recall is not affiliated with
  Vakaros.
- **Wind is estimated.** The boats carry no wind sensor. The true wind
  direction comes from the fleet's steady upwind headings: a two-cluster
  circular k-means splits them into the two tacks, and the bisector is the
  wind. Each beat's estimate is pinned at the beat's mid-time and the wind is
  interpolated in time between them. The wind at the gun (the line bias, the
  start chart's orientation) comes from the fleet's tacks from 30 s to 3:30
  after the gun (`START_WIND_FROM_MS`, `START_WIND_TO_MS`: the first seconds
  are still the start), pinned at the gun, so a shift during Beat 1 doesn't
  leak back to the start. Each boat is read every 2 s at its nearest steady
  fix within 5 s (none that near is a hole), so a device logging every 0.3 s
  counts no more than one logging every 10 s. Only close-hauled headings count:
  those within 10° of their tack's mode, so boats footing to clear a transom,
  reaching or luffing don't pull the bisector. It needs 150+ such readings
  (5 boat-minutes), 30+ and 20 % of them on each tack, and a tack angle within
  8° of Beat 1's, read the same way. Otherwise Beat 1's estimate is held back
  to the gun as before (`WindInfo.startWindowFail` says why), and the labels
  say which was used. If there isn't enough
  upwind data, the app falls back to the weather model, or failing that,
  assumes the first leg is dead upwind, and says so. Every TWA and VMG figure
  is therefore an estimate and is labeled that way.
- **Legs** are split at each boat's closest approach to the mark trackers,
  using a 90 s window that opens when the boat first comes within 45 m. Mark
  positions are followed over time, because committees re-lay marks between
  laps. If most finishers clearly didn't sail the listed course, it is
  treated as shortened. A rounding that falls in a telemetry hole shorter
  than ¾ of the fleet's quickest median leg (it can hide no more than that
  rounding) is estimated across the hole, by the boat's distance to the mark
  at the fixes either side, and its leg time marked `~`; like `~` distances,
  it still ranks. In a longer hole it is unknown, and a leg over twice the
  fleet's median with such a hole has likely lost roundings, so it and the
  legs after it are unknown too. Unknown legs show — and stay out of places
  at the mark, ▲/▼ and the Upwind/Downwind totals; the track is still drawn
  (`analysis/legs.ts` `checkBounds`).
- **Heading.** TWA, the heading at the gun and the bow offset use each
  device's compass, unless it is a median of over 30° off the GPS course at
  speed (a broken compass; leeway and current are a few degrees). Then the
  course over ground stands in, the boat is left out of the wind estimate,
  and the tables show `⚠ heading from GPS course`.
- **Tracker glitches** are cleaned before anything else (`data/racesense/adapter.ts`),
  for boats only (marks, committee and coach boats are kept as sent). A sail
  with two trackers is drawn from the one covering the most ground (~11 m
  cells), not the one with the most rows: a spare left ashore can send the
  most. A fix a moving boat (over 1 kn) already sent earlier, at the exact
  same coordinates, is a held fix replayed among the live ones and is dropped
  (sending the same fix twice in a row is kept). A boat's fixes over 20 km
  from the fleet are dropped. A reported speed over 25 kn that is more than
  twice its positions' speed plus 10 kn is no reading, and the speed comes
  from the positions instead (single spikes of 1,500–12,000 kn; M32s at
  25–29 kn keep theirs).
- **Finishes** whose feed distance is under half the fleet's median, or whose
  max speed is over 1.6× the fleet's, aren't ranked (spare and judge trackers
  that "finish" from a committee boat, a media RIB). The device's distance
  counter skips its own dropouts, so a short distance is excused when the
  boat's track has holes that make up the difference and it went at least
  half as far from the line as the fleet. A fast max speed is excused when the
  boat's own track tops out within 1.6× the fleet's tracks, went at least half
  as far from the line as the fleet, and crossed the finish line within 30 s
  of the reported finish (C31 Gold Cup race 2: GER 80's device said 30 kt, its
  track 14 kt). A boat with no accepted finish is drawn to its own crossing
  of the finish line plus 15 s (found as tracker finishes are), or to its
  last fix if it never crosses.
- **DTL** comes from each boat's Vakaros device when its start row is valid.
  Our own figure, from the GPS antenna plus the class bow offset, is shown
  alongside as a check. The app flags it when the two disagree widely, which
  does happen. See "Vakaros start data quality" below.
- **"Pin" and "RC"** are the left and right ends of the start line as the feed
  defines them.
- **Politeness:** responses are cached at the edge (Pages Function) and in the
  browser (Cache API). Finished races are cached for a long time, so a repeat
  visit makes no telemetry requests. There is no bulk downloading.

## Race list, official results and rebuilt races

The race picker lists every race with a gun and a start line, newest first,
as short options: `Race 4 · Wed 11:40 · RS 5`, `Practice · Mon 09:55 · RS 1`,
`Race 3 · Wed 08:55 · RS 4 · ~ tracker`, `Race 8 · Fri 09:55 · rebuilt`
(Eastern time; the select's tooltip says EDT/EST; `RS n` is RaceSense's own
number, shown when it differs). The race header shows the same name, with
RaceSense's number as a small `RS n` tag, and one line of chips with an ⓘ
"Results & numbering" (`#race-head`). The list first shows from RaceSense
alone; official results and the feed check run afterwards and relabel it.

**What is listed.** Zero-finisher races now appear: their finishes come from
the official results or the tracks. Hidden: a race with no recorded start line
or a gun more than a day outside the event's dates (AYC Fall Series J105 race 6:
four starts on Oct 13, a week after the weekend, no line). **Practice:**
RaceSense's `isPractice`; when linked, a race before official race 1 with no
official race at its gun; when not linked, a lone zero-finisher race on the
first racing day before the first day with finishes (J/70 Worlds Monday).

**Official results (Yachtscoring)**, `src/data/official/`. Candidates come from
one start-date search (event start − 10 days to end + 1 day), else a name
search. They are scored on name words (acronyms count: "CBC" = "Chesapeake Bay
Championship"), date overlap and venue (name 0.6, dates 0.3, venue 0.1; ≥ 0.35
to be checked; best 3). Each is then checked on what can't be faked. Per
RaceSense division, every class (circle + class) scores on:
- start times (0.45): share of the division's guns with an official start within
  2 min after the time-zone fix;
- sail numbers (0.45): share of boats paired by sail over the smaller fleet,
  from one race report;
- class name (0.1).

A class links only at ≥ 0.6, with ≥ 60% sails paired and a 0.15 margin over the
next class. An automatically matched event must also beat the next candidate by
0.15. Otherwise there is no link (`⚠ no official results linked`).

- **Time zone:** Yachtscoring writes local wall clock with a `Z`, and its
  `localGMTOffset` can be wrong (−5 in Annapolis in October). The offset is the
  whole or half hour that lines up the most starts with RaceSense guns; ties go
  to the RaceSense race's own offset.
- **Races** match by gun (closest first, ≤ 2 min), then left-overs in order
  between matched ones (≤ 45 min apart), never by number.
- **Boats** pair by sail in tiers, each pairing unique keys only: country +
  number; number without prefix ("USA"/"US"/"Uni"/"None"/country, spaces,
  punctuation, leading zeros: "0005" = "USA 5"); digits only ("251-L" =
  "USA 251"); boat name. Unpaired boats get a ⚠ chip, with the list behind the ⓘ.

**Finishes.**
- **Linked:** official places and codes (DSQ, DNF, OCS, …) are the places the
  app uses. An AOK boat that RaceSense flagged OCS is cleared; a coded boat has
  no place. Every row keeps its score (`placeClass`: a coded boat's points, SCP
  fractional). The codes are one table (`src/data/official/codes.ts`: plain
  words, and whether the boat finished): a boat that **finished with a code**
  (DPI, SCP, ZFP, RDG with a finish time; DSQ / UFD / BFD with one) keeps its
  finish, race time and legs and gets an **on-water place** (by corrected, else
  elapsed, time among the official finishers: where it would be without the
  code) and the places the code cost (points − that, to 0.1, never below 0). DNF,
  RET, OCS, TLE, NSC, DNS, DNC, DNE, and DSQ / UFD / BFD without a finish time,
  score as not finishing. Where the app orders boats by how they sailed (the boat
  order, the places chart's finish, the leg story's finish column, the Coach's
  groups, D5 / D10's boats ahead) a penalized finisher sits at its on-water place
  (`finishRank`, `src/analysis/result.ts`); where it shows the result (header
  chip, Fin column, boat list, Regatta places) it shows the code with its points
  ("DPI 15", "12th on the water" in the title). Findings text and the winner use
  official places only.
- **Official times** are used only if plausible: ≥ 3 finishers have a
  finish-line crossing within 10 min of their official time, the median gap is
  ≤ 60 s, and every official finish is after the gun and before the next gun.
  Otherwise the chip is `official places · RaceSense times` (or tracker times),
  a plain note, and times come from RaceSense's finish, else the crossing.
- **Not linked:** RaceSense's finishes. A race with none gets **tracker
  finishes**, marked `~` per boat in the boat list and `⚠ ~ tracker finishes` on
  the race. A tracker finish is the first crossing of the finish line (its two
  trackers, where they were at the time; the start line's trackers when the
  course has no finish line) after the boat's own `race_stage` turned
  `finishing` (its last leg), and not before the fleet's onset (20th
  percentile) less a minute. Without stage rows it is the first crossing after
  the boat's last time ≥ 70% of its furthest distance out. A track that doesn't
  cross gets no finish.
- Cascais race 2, with RaceSense finishes as truth: 98/100 reproduced, median
  0.6 s off.
- **Not in the race:** in such a race (no RaceSense finishes, no official
  results), a tracker that stays over 1 km from the start line's middle from
  5 min before the gun to 10 min after, and never finishes, is set aside as not
  racing. A boat with a placeholder sail (0000) or "Coach" in the name and no
  finish is set aside the same way. They are then out of the start view's Fit,
  the ranks and the findings. Cascais official race 4 had three boats scored
  DNC that sat 4.9 km off.
- **Start Fit:** boats whose |DTL| is over ~300 m (or 4× the fleet's 80th
  percentile) are listed as away from the line and left out of Fit and start
  places, so one late boat kilometers out cannot collapse the chart.

**Rebuilt races**, `src/data/orphans.ts`: races the tracks show but RaceSense
doesn't list.
- **Gun:** every telemetry row carries `race_number`/`race_stage`. A race's gun
  is where its devices flip from `starting` to `in_progress`: the third-earliest
  device, rounded to the second, stored +1 s because RaceSense's startTime is
  hh:mm:01. A race number that starts again is a restart, and the later start
  wins.
- **Start line:** the start-line trackers' positions at the gun, else the
  nearest listed race's line.
- **Probe rule, linked:** one 60 s window at each official start RaceSense
  lacks. A flip there gives the gun. No flip, but the division's boats moving,
  gives a rebuild at the official start (`rebuilt · official gun`).
- **Probe rule, not linked:** applies after the last listed race of each racing
  day that has fewer races than the event's busiest day (practice-only days
  skipped). It probes 10 s at 3 min after that gun, then every 30 min for up to
  4 h until the feed goes quiet. Then it binary-searches each later race
  number's last starting → in_progress bracket and refines with a 60 s window.
- **Budget:** at most 48 requests per event, cached 30 days once the event is
  over a day old. It runs after the list renders, with a progress chip
  (`checking for more races 12/48`; `⚠ feed check incomplete` if the budget
  runs out). Up to 3 short racing days are probed at once; the request budget
  is unchanged.
- **URL:** a rebuilt race's number is its gun's UTC minute, `YYYYMMDDHHMM`
  (`race=202609111355`), which can't collide with RaceSense's small numbers.
  Old `race=<RaceSense number>` links open the same race as before.

**Manual link.** In the ⓘ, paste a `yachtscoring.com/emenu/<id>` link or the
number (sets `ys=<id>`). **Off** sets `ys=0`; **Auto** drops `ys`.
`ysc=<split id or circle|class>` picks the class. Both are kept in the URL and
the saved last view, and dropped when another event is picked.

**Failures** (Yachtscoring down, 4xx, malformed, no match) keep RaceSense
numbering with a chip: `⚠ official results unavailable`, `⚠ no official results
linked`, or `⚠ no official match` for one division. Nothing else changes.

**Goldens** are in `tests/recoveryGolden.test.ts`. Their fixtures come from
`npx vite-node scripts/make-recovery-fixtures.ts -- <cache-dir>`, which needs
the network once.
- J/105 CBC ↔ 50575: official places used, placeholder times rejected.
- AYC Fall Series weekend 1 ↔ 50574: the Weekend 1 circle; J70 RaceSense race 1
  = official race 2; official race 1 rebuilt.
- J/70 Worlds (no Yachtscoring event): 10 races + practice, numbered in order;
  official races 4 and 8 rebuilt. Tracker places vs Sailti's official places:
  Spearman 0.97–1.00, ≥ 99% within ±2 places.

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
- **Holes in our check.** The public track is about 2 Hz but loses points near
  the gun. Our figure is interpolated across the hole if the nearest real point
  is more than 2 s from our sample, or if the hole bracketing the sample is
  longer than 5 s (even when a neighbor is within 2 s). It is never ranked
  (the Vakaros figure ranks the boat when there is one), but it is shown like
  any other figure, with its Late (s): no `~`, no gray, no note.
- **Disagreement.** If both figures are valid and differ by more than 3 m,
  the Vakaros value gets a ⚠. If Vakaros has no usable fix and our figure is
  under 1 m (near or over the line), the boat is flagged as one race
  control's OCS check didn't cover ("Vakaros had no OCS check for this boat").
- **Ranking** uses one value per boat: Vakaros when it's valid, otherwise ours
  when it's valid, otherwise the boat is unranked. The table's Start column
  shows the place among clean starters and the source (`V` or `ours`).
  Every caveat is listed under the table so it can be read on a phone.

## Architecture

```
src/
  data/types.ts              RaceData: the normalized race model (the seam)
  data/racesense/            RaceSense source adapter (pure) + fetch/pagination
  data/vkx/                  boat-log uploads: .vkx parser, compact payload, race/boat matching, merge, upload API client
  data/official/             Yachtscoring: parsing, sail numbers, matching, linking
  data/finishes.ts           finish-line crossings, tracker finishes, plausible official times
  data/raceList.ts           the race list: practice, hidden races, numbering
  data/orphans.ts            rebuilt races from the feed's race stages (bounded probes)
  data/recovery.ts           glue: link request, per-race official input, probe fetcher
  data/cache.ts              memory + Cache API caching
  analysis/                  RaceData -> RaceAnalysis (geometry, legs, wind, tacks/gybes, heel, coverage, upwind/downwind summaries, places at each rounding, findings)
  worker.ts                  fetch + normalize (+ merge uploaded boat logs) + analyze, off the main thread
  vkxWorker.ts               boat-log upload: parse, match, pack, off the main thread
  ui/                        plain TS + SVG rendering (ui/vkxUpload.ts: the upload bar and dialog)
functions/api/[[path]].ts    Cloudflare Pages Function: cached proxy for landing/regatta/wind/telemetry/ys
functions/api/vkx/*.ts       boat-log upload routes (upload, list, data, delete)
functions/_lib.ts            allowlist, query validation and cache TTL (not a route)
functions/_vkx.ts            boat-log handlers, validation, feed check, R2 layout (not a route)
functions/api/auth/, billing/  paywall routes (off unless PAYWALL_ENABLED): sign-in, Stripe Checkout, webhook, portal
functions/_paywall.ts        paywall flag, session cookie, the gate the data routes call
functions/_auth.ts, _stripe.ts, _authDb.ts, _entitlements.ts  sign-in, payments, D1 queries, who may see what
src/data/freeRace.ts         race 1 and its free telemetry window (shared by the gate and the page)
src/ui/paywall.ts            lock card and account sheet (only when /api/auth/me says the paywall is on)
migrations/0001_paywall.sql  D1 schema for the paywall (not applied: see Paywall)
tests/                       vitest; offline, using tests/fixtures (benelux_r8, c31_r10, m24_r4, j88_r5, j105_r1–r3, ic37_r5, gate_*, cascais_r2, cascais_r3, anom_*: tracker glitches, vkx/, stripe/: fake webhook events); tests/d1mem.ts runs the paywall's SQL against the migration's schema in memory; tests/setup.ts yields to the event loop after each test (a long run of synchronous tests otherwise times out vitest's worker RPC, 'Timeout calling "onTaskUpdate"')
scripts/make-fixture.mjs     builds the trimmed fixtures from raw downloads (--preset benelux|c31|m24|j88|j105|j105r1|j105r3|ic37|gate-*|cascais-r2|cascais-r3)
scripts/make-anomaly-fixtures.mjs  builds tests/fixtures/anom_* (a stuck tracker, a replayed fix, SOG spikes, M32 speeds) from the raw-feed anomaly scan
scripts/make-recovery-fixtures.ts  records tests/fixtures/recovery (Yachtscoring, probes, finishing bands; network once)
scripts/make-vkx-fixture.mjs builds tests/fixtures/vkx from a boat log + regatta doc
scripts/landing-thumbs.mjs   the landing cards' screenshots (public/landing/*.webp) from a running server; Playwright from PLAYWRIGHT_CORE
scripts/vkx-dev.mjs          `npm run dev:vkx`: Vite + the upload routes over an in-memory R2
```

The analysis only ever sees `RaceData`. An uploaded boat log is merged into
its boat's `Track` before the analysis (`src/data/vkx/merge.ts`).

The algorithms are ported from a Python prototype. Against its output for
Benelux Sailing League Act III, J70 race 8
(`tests/fixtures/benelux_act3_race8_metrics.csv`), the tests reproduce:

- every start and leg metric within the tolerances (DTL ±1.5 m, speed ±0.3 kn,
  TWA ±6°, leg time ±10 s);
- the finish order exactly.

## Boat-log (.vkx) uploads

A boat's own Vakaros log (`.vkx`, VKX 1.4, 10 Hz on an Atlas 2) can replace
its gappy public track in a race. On the race header: **Add boat log (.vkx)**.
While no boat in the race has a log it is a card saying why ("Sailed with a
Vakaros? Add its log (.vkx)": 10 fixes a second instead of the tracker's 1 or
fewer, for the start, mark roundings and penalty turns); once one has, it
shrinks to the chip line. With uploads unavailable there is no card, only the
chip.

**Uploads are public.** Anyone viewing the race sees the uploaded boat's
full-rate track; there is no private option. The confirm dialog says
"Shared publicly with everyone viewing this race".

The flow, in a Web Worker (`src/vkxWorker.ts`):

1. **Parse** (`src/data/vkx/parse.ts`): one DataView pass into typed arrays.
   It reads position rows (0x02, with heading, heel and trim from the
   body-fixed quaternion, which match the feed's heading, roll and pitch),
   declination (0x03), timer events (0x04) and line pings (0x05). Every
   other known row is skipped by length. An unknown key or a truncated row
   stops it, keeping what it read and saying why. A non-.vkx file is
   rejected at once. A 10.5 MB day log parses in ~25 ms warm (~50 ms
   cold) in Node.
2. **Races** (`match.ts`): every gunned race of the division, including
   those the picker hides today (no finishes). A race counts as covered when
   the log covers ≥ 50% of its gun → finish. With no finishes, the end is
   estimated: gun + 2 h, or 5 min before the next gun.
3. **Boat**: the log is compared with every boat's feed track in 8 × 50 s
   windows spread over the race. At each feed fix the log is interpolated
   (only between fixes ≤ 2 s apart).
   - **Match:** median < 5 m on ≥ 30 fixes, and the runner-up ≥ 25 m
     (and 5×) away.
   - **Sparse:** fewer fixes (≥ 5), or two boats agree. The user confirms
     the boat.
   - **None:** the log is refused.
   The feed is a subset of the device's own fixes, so the right boat agrees
   to ~0.1 m.
4. **Confirm**: chips for the boat, each race's coverage gain (e.g.
   `R7 35% → 100%`; `≈` when estimated from the check windows), the rate and
   the public-sharing line.
5. **Upload** one payload per race. A delete token is kept in localStorage,
   and **remove my upload** appears for that browser.

**Payload** (`compact.ts`, "RVKX" v1): the boat's samples from 5 min before
the gun to 2 min after the end, at the full 10 Hz. Columns are delta + varint
coded:

| Column | Encoding |
| --- | --- |
| time | ms, exact |
| lat/lon | 1e-7°, exact |
| SOG | cm/s |
| COG, heading, heel, trim | 0.1° |

All of it is gzipped, with a JSON header: ids, gun, device sn, sail, rate,
counts, span, timer events and line pings from 1 h before the gun,
declination, and the source file's SHA-256. USA 833 on Fri Sep 11 2026:
R7 ≈ 410–465 KiB (67–76k samples), R8 327 KiB. One level is stored, not
a decimated copy: a race is a single ~0.4 MB immutable, cached fetch.

**Merge** (`merge.ts`): when a race loads, its upload list is fetched; this
never blocks the first render. New payloads are fetched and the race re-runs
with them:

- Feed fixes inside the log's span are replaced. Fixes outside it, or in a
  log hole > 2 s, are kept. There is no time shift: the clocks agree to
  ~30 ms.
- The analysis gets the log at 5 Hz from 130 s before to 30 s after the gun,
  and 1 Hz elsewhere. At full rate one boat would outweigh the fleet's pooled
  wind estimates and GPS jitter would lengthen its distance.
- The map draws ≤ 1 Hz as before.
- The boat gets a `10 Hz` tag in the boat list ("from boat log · 10 Hz") and
  a chip on the map key. Coverage numbers reflect the log.
- The boat's own timer and line are cross-checked:
  - ⚠ `boat timer Δ +Xs` when its RACE_START is more than 3 s off the gun
    (RaceSense records guns ~1 s after the boat's zero, so USA 833 shows −1 s
    and no chip).
  - ⚠ `line pin/boat end N m off` when a pinged end is more than 15 m from
    the race's line.

**Server** (`functions/_vkx.ts`), all JSON errors with `cache-control: no-store`:

| Route | |
| --- | --- |
| `POST /api/vkx/upload` | body = one gzipped payload, `content-type: application/octet-stream`, ≤ 2 MB (413; 415 for another type). It is decoded with the client's code (12 MB unpacked cap) and validated: ids (400), then the samples (422). Timestamps must strictly increase, positions be in range, SOG ≤ 25 m/s, at most 0.1% of steps faster than 25 m/s (+10 m slack), rate ≤ 20 Hz, span 1 min–5 h, gun inside the window, and the header must agree with the body. Then the **anti-fake check**: the same 8 × 50 s windows of the device's feed are fetched from teleapi.regatta.app (same host and UA as the proxy, at most 8 GETs, stopping once 30 fixes agree), and the median must be < 5 m (422 `mismatch` / `too-few`), and that device must sail under the payload's sail number in the feed (422 `sail`: the client merges by sail). If teleapi can't be reached, 503 and nothing is stored. Newest wins per event/division/race/boat; the one replaced is kept as `.prev` (one level), unless the same uploader replaces their own (`x-replace-token`). Returns the delete token once. |
| `GET /api/vkx/list?event&div[&race]` | the current uploads (boat, race, rate, counts, span, uploadedAt, size, sha, data URL). `cache-control: public, max-age=60`, and 60 s in the edge cache, purged (awaited) on upload/delete in that data center. `&fresh=1` (the uploader's own re-read) skips the edge copy and refreshes it. |
| `GET /api/vkx/data?event&div&race&sn&h` | the payload. `h` is its SHA-256, so the URL is content-addressed: `public, max-age=31536000, immutable` for browsers. It is deliberately not kept in the edge cache, so a removed upload stops being served (one R2 read per uncached fetch). A stale `h` (replaced upload) gives 404. |
| `POST /api/vkx/delete` `{event, div, race, sn, token}` | removes the current upload and brings back the `.prev` one, if any. A token of an upload since replaced removes that `.prev`. Wrong token 403. |

- **Missing binding:** with no `VKX_BUCKET`, every route answers 503. The
  button then reads "⚠ uploads unavailable", disabled, and its ⓘ says why.
  The same happens on an R2 error, offline, or in dev without the routes;
  the rest of the app works as usual.
- **R2 layout:** `v1/<eventId>/<base64url(division)>/<raceId>/<deviceSn>.bin`
  (+ `.prev.bin`). The facts live in customMetadata: sha, token hash, sail,
  name, rate, counts, span, gun, size, uploadedAt, source SHA-256, check
  result.
- **Ids:** `[A-Za-z0-9_-]` patterns. The race id is any 1–32 such
  characters, so recovered races' ids fit as well as today's numbers.
- **Delete tokens:** 32 random bytes. Only their SHA-256 is stored, and
  they are compared in constant time.
- **Rate limit:** 20 uploads per 10 min per client, in memory per isolate,
  keyed by a salted hash of the IP that never leaves the isolate. It is
  best-effort: isolates and data centers don't share it.
- **Logging:** nothing identifying (no IPs, no user agents).
- **Route precedence:** Pages serves the most specific route first, so
  `functions/api/vkx/*.ts` (static paths) win over the catch-all
  `functions/api/[[path]].ts`, which never sees `/api/vkx/*`.

**Caveats**

- The anti-fake check proves a log follows its boat's *public* track. It
  stops wrong-boat uploads and off-course or edited tracks. It can't stop a
  track built from the public feed itself; that feed is public anyway.
- A race with no finishes has an estimated end, so its payload may run into
  the next race's pre-start.
- **R8 on Fri Sep 11 isn't in RaceSense's race list** (an orphan), and R7
  has no finishes, so the picker hides it. Uploads for R7 work now
  (`raceWindowsFromDoc` includes hidden races) and show once R7 is listed.
  R8 needs the race-recovery work: pass its window as `extra` to
  `raceWindowsFromDoc`.

## Ask Coach (optional)

A chat panel at the top of the Coach tab (under the boat's heading, above
the gap chart and the cards), in the Race and Regatta views: an accent-
bordered card, open by default (collapsible). The sailor asks about the race
(or regatta) on screen and an Anthropic model answers **only from the
Coach's own numbers**, which the browser sends with the question. Three
one-tap starter questions come from the boat's own race (`askStarters`,
`ui/coachAsk.ts`): the leg the top Coach card sits on (`Why did I lose
places on Beat 1?` when places went there, else `Where did I lose time on
Run 1?`; with no card on a leg, the leg that lost the most places), `What
cost me the most?`, and `How was my start?` (`How much did being over early
cost me?` when over). A starter Recall can't fill in falls back to the general questions; the
Regatta view uses its own three. A tap sends the question exactly as typed
and Ask would (same limits). The feature is **off unless
`ANTHROPIC_API_KEY` is set**: `/api/coach/status` then says `enabled:false`
and the panel isn't shown at all (nothing takes its place);
`/api/coach/ask` answers 503 `not-configured`.

**Setup (one-time)**

1. **API key.** In the [Anthropic Console](https://platform.claude.com) →
   API keys → Create key (give it its own workspace, e.g. `recall`). It is
   billed to the account's API credits (Claude Max / API credits, whichever
   the account has for API use). Under **Limits**, set a **monthly spend limit on that workspace**
   (e.g. $10): it is the hard backstop behind the app's own daily cap.
2. **Secret.** Cloudflare dashboard → **Workers & Pages** → project
   `start-line` → **Settings** → **Variables and Secrets** → **Add** →
   type **Secret**, name `ANTHROPIC_API_KEY`, the key as value, for
   **Production** (and **Preview** if you want it there too). It is
   encrypted; nothing in the repo or the browser ever sees it.
3. **Optional variables** (plain text, same place):

   | Variable | Default | What |
   | --- | --- | --- |
   | `ASK_COACH_MODEL` | `claude-haiku-5-5` | model id |
   | `ASK_COACH_DAILY_USD` | `2` | estimated spend cap per UTC day, $; over it the panel says "Ask Coach is resting for today" |
   | `ASK_COACH_SESSION_MAX` | `10` | questions per chat (per IP + chat; a chat resets on a change of race, boat, view or peer group) |
   | `ASK_COACH_DAILY_MAX` | `30` | questions per IP per 24 h |
   | `ASK_COACH_GATEWAY_URL` | (none) | a [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/) base, `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic`, used instead of `https://api.anthropic.com` (logs, analytics, its own limits). `http://localhost`, `http://127.0.0.1` and `http://[::1]` are allowed for a local stub; any other `http` URL is ignored |
   | `ASK_COACH_EFFORT` | `low` | `low` / `medium` / `high`, sent with up-front thinking off where the model allows it (Haiku: `disabled`; Sonnet 5.5: `between_tools`; others: left on), or `default` to send neither (for a model without the effort setting) |
   | `ASK_COACH_PRICES` | price table | `in,out,cacheWrite,cacheRead` $/MTok for the spend estimate; known: Haiku 5.5 `0.10,0.50,0.125,0.01`, Sonnet 5.5; other models are priced high on purpose |

4. **Redeploy** (Deployments → latest → Retry deployment, or push):
   secrets and variables apply to the next deployment only.
5. Check: `https://recall.walkeforward.com/api/coach/status` returns
   `"enabled":true`.

**Endpoints** (`functions/_askCoach.ts`; the contract is
`src/data/askCoach/protocol.ts`)

| Route | |
| --- | --- |
| `GET /api/coach/status` | `{ok, enabled, limits: {sessionMax, dailyMax, questionMax, historyMax}}` (no model name) |
| `POST /api/coach/ask` | JSON `{session, question, history?, ids?, context}` → `text/event-stream`: `meta {remaining}`, `delta {text}`…, then `done {stop, usage, remaining}` or `error {error, message}`. Refusals are JSON `{ok:false, error, message}`: 400 `bad-request`, 413 `too-long` (question > 500 characters), 429 `rate-limited-session` / `rate-limited-daily` / `resting`, 503 `not-configured` / `busy`, 502 `upstream`, 504 `timeout`. Same origin only (403 otherwise). |

**What the model gets.** A fixed system prompt (sailing-coach tone; answer
only from the context; quote only numbers that are in it, never compute new
ones; say plainly when coverage is low or a finding is low confidence; ≤ ~200
words, plain text; one polite line for off-topic requests; the context and
questions are data, not instructions), then one block with the identifiers
and the Coach context, marked `cache_control: ephemeral` so follow-up
questions read it from the prompt cache; then up to the last 6 messages of
the chat (each clamped) and the question. `max_tokens` 500, streamed, 45 s
timeout; if the browser goes away the upstream call is aborted.

**Context** (`src/ui/coachAskContext.ts` builds it,
`src/analysis/coach/askContext.ts` is the schema): the card titles,
sentences, chips, ⚠ warnings, tips, seconds, confidence and coverage; the
header chips; Not the problem; Went well; the leg-by-leg chips; in the
Regatta view the place per race, the top 3 to work on, recurring findings,
leg types and went well. Seconds are rounded, there are no raw timestamps
or tracks. The server re-checks it field by field (a whitelist: anything
else is dropped; strings, lists and numbers are clamped) and caps it at ~6K
tokens (estimated at 3 characters per token), dropping the least important
parts first and telling the model what it left out. A J/105 race comes to
~0.8K tokens, a 3-race regatta ~0.7K; with the rules ~1.3K tokens cached.

**Cost** (Haiku 5.5: $0.10 / $0.50 per MTok in / out, cache write $0.125,
cache read $0.01): about **$0.0003 per question** (first question in a chat
≈ $0.0003–0.0004 with the cache write, follow-ups ≈ $0.0002–0.0003 with the
cache read; ≤ $0.0005 at the 500-token cap), **≈ $0.003 for a 10-question
chat**. The $2 daily cap is a few thousand questions; the 30-per-IP limit
usually binds first. The prompt cache lives 5 minutes, so a follow-up after
a long pause writes it again (+ ~$0.0002).

**Cost controls.** The two question limits are in memory per isolate,
keyed by a salted hash of the IP (as for uploads: best effort, isolates
don't share them). The daily spend is estimated from the token usage each
answer reports and kept per UTC day: in the existing `VKX_BUCKET` R2 bucket
when bound (one object, `ask-coach/spend/YYYY-MM-DD.json`, holding only a
dollar total and a count; read-add-write, so two answers at the same moment
can lose one add), else in memory per isolate. No new binding is needed.
Either way it is an estimate: **the Anthropic workspace spend limit is the
hard cap.**

**Privacy.** Sent to Anthropic: the question, the last few messages of the
chat, the event/division/race ids, the boat's sail number and boat name,
the peer group, and the Coach numbers above. Never owner, crew or skipper
names (Yachtscoring's are stripped at the proxy, and the context schema has
no field for them). Nothing is logged or stored by Recall: no questions, no
answers, no IPs. Anthropic's API data-retention terms apply to what it
receives. The panel says "Answers use only Coach's numbers; AI can make
mistakes."

`npm run dev` has no Ask Coach route (the panel stays hidden).

## Paywall (phase 1, behind PAYWALL_ENABLED)

Race 1 of every regatta stays free; races 2+ need a pass. **Off by default:**
with `PAYWALL_ENABLED` unset (only `1`, `true` or `on`, any case, turn it
on) every existing route answers exactly as before, and every
`/api/auth/*` and `/api/billing/*` route (`/api/auth/me` and the Stripe
webhook included) answers the proxy's own `404 {"error":"Unknown endpoint"}`,
byte for byte, without touching D1. The page learns the flag from one
`GET /api/auth/me` at load (never from the build): a 404, or any other answer
than a well-formed `{"paywall":true,…}`, means off, so it shows no sign-in
or lock UI and logs nothing.

**Passes.** Regatta by regatta: race 1 of every regatta is free; unlock the
rest of a regatta for $50. *Regatta Pass* ($50, one-off, the only pass on
sale): one event id, every division and boat. *All-regattas pass* (scope
`season`): every regatta while it runs; no longer sold (checkout refuses
`season`, and the page offers nothing but the Regatta Pass), but honored
everywhere for whoever holds one: an earlier Season Pass subscription
(still renewed, changed, ended and refunded by the webhook, with Manage
subscription for its owner) or a gift (below). *Coach plan* ($499/yr, 6 seats): in the data model only (owner plus the
first `seats` members of `team_members`), no checkout yet. Payments go
through Stripe Checkout with Stripe Managed Payments (Stripe as merchant of
record) on the Walkeforward Stripe account; every key and price id comes
from the environment (test mode first).

**What is gated** (`functions/_paywall.ts`; race 1 per `src/data/freeRace.ts`):

- *Race 1* is each division's earliest non-practice race in the race list
  built from the RaceSense document alone (a gun, a start line, inside the
  event's dates; no official link, no rebuilt races), so the server and the
  page always agree. Rebuilt races (`race=YYYYMMDDHHMM`) are never race 1:
  they are found in the browser only and lie outside race 1's window.
- `/api/telemetry/event/ID?after&before[&division]` is free when the whole
  window lies inside race 1's free window: what Recall fetches for race 1
  (`telemetryWindow`: gun − 130 s to the last finish + 30 s, or to the next
  gun − 1 min with no finishes) widened by 5 min before and 2 min after,
  never back into an earlier race's window nor past the next gun − 1 min.
  Race 1's pages all share its `before` and start inside, so they are all
  free; a window reaching past it (a later race, a chunk of one, or one
  spanning races 1 and 2) needs a pass. With `division` (a division the
  document has), that division's window counts; without one the response
  can carry every division, so it must lie inside every division's race 1
  window (in a multi-division event the unfiltered mark top-up of race 1 may
  then be refused: the worker carries on without those marks).
- `/api/vkx/data` (boat logs): race 1's are free, others need a pass.
- `/api/coach/ask`: free only when the server can tell the question is
  about race 1 alone, from the regatta document it fetches itself rather
  than the page's labels, over the whole parsed request
  (`askRequestIsFree`): the Race view with no regatta section, ids naming
  the division's race 1, and a context whose division, event name and race
  name agree, whose header shows race 1's gun on the venue clock (±1 min);
  then every string of the context (every field), the question and the
  earlier turns may name no other race (`R3`, `Race 3`, `RS 4`, `races 2`,
  `race #5`: only race 1's own names pass), hold no clock time outside race
  1's free window (±1 min) and no ISO or Unix timestamp. The page's own
  m:ss durations that read like clock times (a leg's `fastest … 15:54`, the
  start card's `2 tacks by 2:48`) are exempt where the page puts them, and
  in the question and turns only the ones the context shows (answers quote
  them). The context is capped at 8,000 characters as JSON and the earlier
  turns at 6,000 (the page's race 1 contexts run 1.5–3k; its turns are 3
  questions and 3 answers of about 200 words), so a bulk paste can't ride
  along. Anything else needs a pass for the event (401 / 402). **Residual
  risk:** a sailor (or a script) can still type anything that names no
  other race and no clock time outside race 1 (prose, numbers, a
  leg-time-shaped `13:46`), within the caps, and ordinal wording ("the
  second race") isn't parsed. Recall itself never serves paid data here:
  the answer is the model's, from what the request carries, and Recall's
  analysis of races 2+ (tracks, Coach cards) comes only through the gated
  routes.
- Not gated: `/api/landing`, `/api/regatta` (the lock card shows the race
  header and RaceSense finishes from it), `/api/wind`, `/api/ys/*`,
  `/api/vkx/list`.
- A refused request is `401 {"error":"sign_in_required",…}` with no session
  and `402 {"error":"payment_required","eventId","race",…}` without a pass
  (`no-store`). The check runs **before** the shared edge cache is read.
  Gated (entitled) responses never touch the shared edge cache, neither read
  nor written, so nothing paid is ever stored under a public URL: they come
  from upstream every time and go to the browser as
  `Cache-Control: private, max-age=300` with `Vary: Cookie`. Race 1 keeps its
  usual public caching. Sessions and passes are read from D1 on every gated
  request (the session by its primary key, then the user's entitlements by
  their index), never cached, so a purchase, an ended subscription or a
  sign-out counts from the very next request. With D1 down, race 1 still
  works and later races answer 503.
- All of Recall's race data reaches the browser through `/api` (the page
  never fetches Vakaros, regatta.app or Yachtscoring directly), so the gate
  covers everything Recall serves. The tracks themselves also come from
  public Vakaros feeds that anyone can read: the gate covers Recall's
  proxied and analyzed data, not the raw source. The pitch is "unlock the
  analysis".

**Sign-in** (`functions/_auth.ts`): Google, Apple or Microsoft (each only
once its keys are set), and an email sign-in link. *Email links:* 32 random bytes, only their SHA-256 stored, 15 min,
single use; the same answer whether or not the address is known. Asking for
one goes, in order: the body and the address's shape, then Cloudflare
**Turnstile**, then the rate limits, then the link is made and sent.
Turnstile (`TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY`): the account
sheet's email forms (sign in and Restore access) load Cloudflare's script
once, lazily, only when `/api/auth/me` hands the page a site key, and render
an `interaction-only` widget (invisible unless Cloudflare wants a click);
`POST /api/auth/email` and `/restore` then need its `turnstileToken`, which
the server checks with Cloudflare's siteverify (secret, token, the client's
`CF-Connecting-IP`), accepting only `success: true` on this very hostname. A
missing or failed check is a 400 ("Please complete the check and try
again."); siteverify unreachable is a 503: it fails closed. Email sign-in is
offered (`signIn.email`) only with an email provider **and** Turnstile set
up, except on localhost, where the `log` provider works without Turnstile
(and only there: `log` on any other host is not set up, a 503, and nothing is
logged); anywhere else the email routes answer 503 without it. *Rate limits:* at most
5 links per address and 20 per IP per fixed hour, counted in D1
(`auth_rate_limits`, one atomic upsert per key; no count back is a 429) so
every isolate shares the counts; keys are `email:<SHA-256 of the address>` and `ip:<SHA-256 of the
IP>` (never the raw values), and about one request in 100 deletes counters
older than 2 hours. *The email* (`signInMail`, shared by Restore access, which
gets its own first line): plain text plus HTML built for Gmail, Outlook and
Apple Mail (tables and inline styles only, 560px wide, the RECALL wordmark as
live text on the carbon masthead with the gold rule, no images; a
bulletproof "Sign in to Recall" button in the brand blue with a VML fallback
for Outlook desktop; the plain link under it; "works once and expires in N
minutes" from `LOGIN_TOKEN_TTL_MS`; a hidden preheader; `color-scheme: light
dark`). *The link* carries the token in the **fragment**
(`/api/auth/verify#token=…`), which browsers never send, so it stays out of
server logs and `Referer`. `GET /api/auth/verify` uses nothing, so a mail
scanner that prefetches links can't spend it: it serves a small page
(`no-store`, `Referrer-Policy: no-referrer`, a strict CSP whose only
`script-src` is the SHA-256 of its two inline scripts, the token one and the
theme's, no external assets)
whose script reads the token from the fragment (or from `?token=`, the shape
of links sent before, which keep working), takes it out of the address bar
with `history.replaceState`, shows "Signing you in…" and POSTs it to the same
URL. With no script (or if it fails) the page falls back to its **Sign in**
button (an old `?token=` link works with no script at all; a `#token=` link
says to turn JavaScript on). With no token it says the link has expired. The
POST accepts only a same-origin request (`Origin` of this site, or, as the
page's no-referrer policy makes browsers send `Origin: null`,
`Sec-Fetch-Site: same-origin`), uses the token once, sets the session cookie
and redirects (303) to `returnTo` plus `signin=ok`; the app then shows a
"You're signed in as name@example.com." toast (`#signin-toast`, a polite
live region, a close button, gone after 5 seconds, never taking focus) and
drops the marker from the URL. A sign-in that goes on to Checkout skips the
toast. A used or expired token gets a page saying so ("This link has expired
or was already used.") with **Get a new link**
(`/regattas?signin=expired`), which opens the sign-in sheet with a note.
*Google:* state, nonce and PKCE in a signed 10-minute cookie; the ID token
from Google's token endpoint is trusted over TLS, its claims checked: issuer,
audience, expiry, verified email, nonce; linked by email; a sign-in lands
with the same `signin=ok` toast. `returnTo` is a path on this site or an
https page on walkeforward.com or a subdomain, else `/regattas`.

*Microsoft and Apple* (`GET /api/auth/microsoft/start`, `GET
/api/auth/microsoft/callback`, `GET /api/auth/apple/start`, `POST
/api/auth/apple/callback`; the redirect URI is this origin plus the callback
path, as for Google). The start routes take the same `returnTo` and buy
intent (`buy`, `event`) as Google's, and their state is signed the same way
(HMAC with `AUTH_SECRET` over `oauth-state.v1.` plus the payload, a purpose
of its own so a checkout marker, signed over `recall-buy:` plus its payload,
can't pass as a state or the other way round; 10 minutes) with the
provider's name inside, so one provider's state is refused on another's
callback. Both ID tokens are verified with WebCrypto against the provider's
JWKS (`functions/_jwt.ts`: RS256 only, the key by `kid` among the RSA keys
whose `use` and `alg`, when given, are `sig` and `RS256`, the keys cached an
hour per isolate and fetched again at most every 5 minutes for an unknown
`kid`; then expiry with 5 minutes of skew, `iat`/`nbf`, issuer, audience
(with more than one audience, `azp` must be our client id) and nonce,
constant-time).
Any failure goes back to `returnTo` with `signin=failed&via=<provider>`; the
page says "Couldn't sign you in with Microsoft. Try again, or use an email
link." (Apple, Google likewise). A success runs exactly Google's tail: a
session with its method (`microsoft` / `apple`, shown in the device list as
"Safari on iPhone · Apple"), the device cap, the checkout marker for a buy
intent, and `signin=ok`.

- *Microsoft* (identity platform v2.0, tenant `common`): authorization code
  with PKCE (S256), `response_mode=query`, scope `openid email profile`,
  `prompt=select_account`; the state cookie is `wf_oauth` on
  `Path=/api/auth/microsoft` (SameSite=Lax: the callback is a top-level
  GET). The token must have `aud` = `MICROSOFT_CLIENT_ID`, a GUID `tid`, and
  `iss` = `https://login.microsoftonline.com/<tid>/v2.0`. The identity is
  `sub` (stable per app and user), with `tid` stored as its tenant.
- *Apple* (Sign in with Apple on the web, no Apple JS):
  `response_mode=form_post`, scope `email` only (names are never asked for,
  stored or shown; the posted `user` field is ignored), state and nonce, no
  PKCE (Apple doesn't document it for the web: the client secret
  authenticates the exchange). The client secret is an ES256 JWT signed with
  `APPLE_PRIVATE_KEY` (kid `APPLE_KEY_ID`, iss `APPLE_TEAM_ID`, sub
  `APPLE_SERVICES_ID`, aud `https://appleid.apple.com`, 5 minutes). The
  callback is a cross-site POST from appleid.apple.com, so a Lax cookie
  wouldn't come back with it: the state rides in its own cookie,
  `wf_oauth_apple` (`HttpOnly; Secure; SameSite=None;
  Path=/api/auth/apple; Max-Age=600`, host-only), cleared on every outcome.
  That route alone skips the same-origin check; instead it needs that signed
  cookie and the posted `state` matching it (constant-time). An `Origin`
  other than exactly `https://appleid.apple.com` (this site's included) is
  refused before anything is read. A missing `Origin`, or `null`, is
  accepted: browsers send `Origin: null` on a cross-site form post from a
  no-referrer page and some privacy tools strip it, and the state check
  already stops CSRF, since an attacker can neither read nor set that
  signed, host-only cookie. `GET` is 405.
  A cancel at Apple (`error=user_cancelled_authorize`) goes back quietly
  (`reason=cancelled`, no notice). Every answer is a 303 (on to a GET);
  the session cookie (SameSite=Lax) set on it is sent with that GET. The
  token must have `iss` `https://appleid.apple.com` and `aud` =
  `APPLE_SERVICES_ID`.

*Linking by email, per provider.* Same verified email, same account (the
owner's decision): no confirmation step. An address nobody proved is never
used to create or link an account, since that account could later collect
what the real owner of the address buys.

- *Email link:* the link proves the address.
- *Google:* `email_verified` must be true; linked by email. Google keeps
  signing in by `users.google_sub` as before, and also writes (best effort)
  its row in `identities`.
- *Microsoft:* the `email` claim (lower-cased) counts only when (a) the
  account is a personal one (`tid` is
  `9188040d-6c67-4c5b-b112-36a304b66dad`) and has an email, or (b) a work or
  school account's token carries the optional claim `xms_edov` true (the
  tenant has verified that it owns the email's domain). Any other work or
  school address is only what a directory admin typed in. An
  `email_verified` claim that is there and false (`false` or `"false"`)
  overrides both: that email is not trusted.
- *Apple:* `email_verified` must be true. A private relay address
  (`is_private_email`, or `@privaterelay.appleid.com`) is verified and unique
  to this app: it gets its own account, and matches only a user who already
  has that very relay address. A real address links to the user with it.

Lookup order for Microsoft and Apple: an existing identity (provider, `sub`)
signs its user in whatever the email says now (Apple often leaves the email
out after the first sign-in). Otherwise a trusted email links to (or
creates) the user with that address and records the identity
(`INSERT OR IGNORE`, then read back, so two first sign-ins at once end on one
user). When that links a new identity to a user who existed before this
sign-in, the account's address gets a short notice, best effort (in
`waitUntil`, never holding up or failing the sign-in; skipped with no email
provider; a failure logged without the address): "Apple sign-in was added
to your Recall account" (or Microsoft), saying that if it wasn't them, open
Recall, go to Account, use Sign out all other devices and sign in again
with their email. It has no button, sign-in link or token, and doesn't
invite replies. Google sends none. Otherwise nothing is created or linked
and the sign-in is refused with `reason=microsoft_email` ("Your Microsoft account didn't share a
verified email address, so it can't be used to sign in here. Try Google,
Apple or an email link.") or `reason=apple_email` ("Apple didn't share a
verified email address, so we couldn't sign you in. Try again, or use Google,
Microsoft or an email link."). Each identity sign-in updates its
`last_used_at`.

*Setting up Microsoft* (Microsoft Entra admin center → App registrations →
New registration): supported account types **Accounts in any organizational
directory (any Microsoft Entra ID tenant) and personal Microsoft accounts**;
platform **Web** with the redirect URIs
`https://recall.walkeforward.com/api/auth/microsoft/callback` and, for
testing, `https://signin-phase2.start-line.pages.dev/api/auth/microsoft/callback`;
a client secret (Certificates & secrets) → `MICROSOFT_CLIENT_SECRET` (note
its expiry), the Application (client) ID → `MICROSOFT_CLIENT_ID`. In **Token
configuration → Add optional claim → ID**, add **`email`** and
**`xms_edov`**: without `email` no Microsoft account can sign in, and
without `xms_edov` no work or school account can.

*Setting up Apple* (Apple Developer → Certificates, Identifiers & Profiles):
an **App ID** with Sign in with Apple enabled; a **Services ID** (its
identifier → `APPLE_SERVICES_ID`) with Sign in with Apple configured for that
App ID, the domains `recall.walkeforward.com` (and
`signin-phase2.start-line.pages.dev` for testing) and the return URLs
`https://recall.walkeforward.com/api/auth/apple/callback` (and
`https://signin-phase2.start-line.pages.dev/api/auth/apple/callback`); a
**key** with Sign in with Apple, downloaded once as a `.p8` (its contents,
the whole PEM → `APPLE_PRIVATE_KEY`, a literal `\n` for each line break is
fine; its Key ID → `APPLE_KEY_ID`); the Team ID → `APPLE_TEAM_ID`. Apple
requires https and registered domains, and doesn't allow localhost return
URLs, so try Apple on the preview alias, not locally.

*Sessions and the device cap:* a random token in the `wf_session` cookie
(`Domain=.walkeforward.com; Path=/; Secure; HttpOnly; SameSite=Lax`, 30
days; no `Domain` on localhost, `*.pages.dev` or any other host), its
SHA-256 in D1 with a public id (12 random bytes, hex: the only id the page
ever sees), the sign-in method, and when it was last used (written at most
once an hour per session, so a normal request adds no write). An account
stays signed in on **up to 3 devices**, whatever the sign-in method (the
admin can set another cap for one user, 1 to 20: [below](#admin-signed-in-devices)).
Signing in on a 4th revokes the least recently used one rather than deleting
it (`revoked_reason 'device_limit'`, `revoked_by` the new session; insert and
revoke are one D1 batch, so racing sign-ins never leave more than the cap; a
session's hourly last-use write trims an account already over its cap the
same way, keeping that session, `revoked_by` NULL), so that
device is told why: its next `/api/auth/me` answers signed out with
`signedOutReason` (`device_limit`, `remote` or `admin`) and clears the
cookie, and the page opens the sign-in sheet once with a note ("You were
signed out on this device because your account signed in somewhere else.
Recall stays signed in on up to 3 devices at a time."). For 10 minutes the
new device's `/me` lists what it signed out (`bumped`), and the page says so
("Signing in here signed out Safari on iPhone (last used Oct 20).") in its own
note under the app's notice line (so loading a race never clears it) until it
is dismissed or the account sheet is opened (the sheet then shows it at the
top); only then is it remembered as seen for that session. A revoked session is signed out everywhere (the data gate,
checkout, the portal, `/me`). Signed in, `/me` adds `devices: { max, list:
[{ id, label, method, createdAt, lastSeenAt, current }] }` (live sessions,
this one first, then by last use; the label comes from the User-Agent,
e.g. "Chrome on Mac"), and the account sheet shows them under **Devices**
("Signed in on 2 of 3 devices.", each with "This device" or "Last used …",
**Sign out** for the others, **Sign out all other devices**): `POST
/api/auth/sessions/revoke {id}` (another live session of the same user, never
this one) and `POST /api/auth/sessions/revoke-others` (every other live one),
both same-site only, `no-store`, reason `remote`, answering `{ ok, devices }`.
Your own Sign out still deletes the row. Expired rows and rows revoked over
30 days ago are deleted at the user's next sign-in.

*Email providers* (`EMAIL_PROVIDER`): `cloudflare-api` (recommended on
Pages: Pages Functions can't use the `send_email` binding, so this POSTs to
Cloudflare Email Sending's REST API,
`https://api.cloudflare.com/client/v4/accounts/<CF_EMAIL_ACCOUNT_ID>/email/sending/send`,
with `CF_EMAIL_API_TOKEN`; a named sender goes as `from: { address, name }`;
sent means `success: true`, and a failure logs the HTTP status and Cloudflare's
error codes, never the token, recipient or link), `resend` (the
fallback), `cloudflare` (an email binding named `EMAIL`, for a Worker or a
service binding later: `send({ from, to, subject, html, text })` with a named
`from` as `{ email, name }`) or `log`
(the default on localhost only; anywhere else an unset provider is a 503,
never a logged link). A missing setting is a 503 naming the variable (never
its value); a failed send is a 502. `EMAIL_FROM` is `Recall
<signin@walkeforward.com>` (or a bare address); the sending domain must be
set up for Email Sending in Cloudflare. Every email has a plain-text and an
HTML part (one "Sign in to Recall" button and the raw link under it, inline
styles, no images). *Restore access* sends a link only to an address with
purchases (same answer either way); passes follow the email, so a webhook
for an unknown address creates its user and signing in with that address
restores everything.

**Payments** (`functions/_stripe.ts`): `POST /api/billing/checkout`
(signed in, else 401; an `Origin` header from this site or an https
walkeforward.com page, as for the portal: missing, `null` or cross-site is
403, and every browser sends `Origin` on the page's fetch POST) creates a
Checkout Session with `fetch`
(`product: 'regatta'` and an event id only: `mode=payment` +
`STRIPE_PRICE_REGATTA`; `season` is a 400 `not_available` with no Stripe
call, and `STRIPE_PRICE_SEASON` is no longer read; metadata product / event id / user id;
`client_reference_id`; the known customer or `customer_email`; success and
cancel back to the race with `checkout=success|cancel`). Managed Payments is
asked for with `managed_payments[enabled]=true` unless
`STRIPE_MANAGED_PAYMENTS` is `0`/`false`/`off`: **confirm that parameter
name (and whether a preview `Stripe-Version` is needed, via
`STRIPE_API_VERSION`) against the Managed Payments docs once the account is
approved**; it lives in `managedPaymentsParams` only. `POST
/api/billing/webhook` checks `Stripe-Signature` (HMAC-SHA256 of
`t.body`, any `v1`, constant-time, 5-minute tolerance; 400 otherwise) and
handles `checkout.session.completed` / `…async_payment_succeeded` (purchase
and pass), `invoice.paid` (an existing season subscription extended to the line's period end),
`customer.subscription.updated` (expiry follows the period end, so a
subscription canceled at period end keeps access until then; `canceled`,
`unpaid`, `incomplete_expired` and `paused` end it now, and a resumed one
runs to its period end again), `customer.subscription.deleted` (ends at
`ended_at`) and `charge.refunded` (below); anything else is 200 and
ignored.

*Refunds.* A **full** refund (`refunded`, or `amount_refunded` ≥
`amount`) revokes what the charge paid for (`entitlements.revoked_at`,
which stops it unlocking from the next request; the first revocation's
time stands, so replays and later refund events are no-ops); a partial
refund keeps the pass. No schema change and no Stripe API call: a *Regatta
Pass* is found by the charge's `metadata` (product, user_id, event_id:
Checkout puts them on the PaymentIntent through
`payment_intent_data[metadata]`, and Stripe copies a PaymentIntent's
metadata onto its charges; **confirm on a test-mode refund that the charge
shows them**). An existing *Season Pass* subscription is found by the charge's `invoice`: its
subscription when the invoice is expanded, else a renewal recorded as an
`in_…` purchase names the user, else (the first invoice, the checkout's
own) the charge's customer, when that user holds exactly one Stripe season
pass bought for that very amount. On API versions from 2025-03-31.basil a
charge no longer names its invoice, so a season refund there is ignored:
cancel the subscription in Stripe as well (immediately), which sends
`customer.subscription.deleted` and ends access. A charge it can't tie to a
pass (another product on the account) is ignored; gift passes are never
touched. *Disputes* (`charge.dispute.created`) are not handled: a dispute
names its charge and PaymentIntent by id only, with no metadata, so tying
it to a pass needs a Stripe API call or a stored charge id (a schema
change); revoke by hand (or refund) if a dispute is lost. Idempotent twice over: handled event ids (`stripe_events`) and
unique keys (`purchases.provider_ref`, `entitlements.purchase_id`,
`entitlements.subscription_id`). With the flag off the webhook is the
proxy's 404 like every other billing route and writes nothing, so try
test-mode purchases end to end on a Preview deployment with the flag on.
`POST /api/billing/portal` (Manage subscription) answers `{url}` of
Stripe's Billing Portal for a customer, and the page then goes there. It is
POST only (`GET` is 405) and needs an `Origin` header from this site or an
https walkeforward.com page (missing or cross-site: 403). Whether Managed
Payments customers use it or Stripe's own management link is to be
confirmed with the account.

**The page** (`src/ui/paywall.ts`): an account button in the masthead (Sign
in / Account: passes with expiry, e.g. "All-regattas pass · every regatta ·
until …" for an existing one, the signed-in devices, Restore access, Manage
subscription for an existing season subscriber, Sign out) and, for a race the viewer can't
open, a lock card (`#lock .lock-card`) in place of the digest: the race
header and RaceSense finishes from the free regatta document, a blurred
placeholder chart (no tracks are fetched), "See the start, every leg and
Coach's top 3 for every boat in R2–R8", **Unlock this regatta — $50** (the
only offer), and "Race 1 of every regatta is free; unlock the rest of a
regatta for $50 · Already bought? Sign in · Restore access". Back from Checkout it re-reads
`/api/auth/me` until the pass lands, then unlocks. Only the sign-in methods
`/api/auth/me` reports (`signIn.email`, `signIn.google`, `signIn.microsoft`,
`signIn.apple`; the last two true only with every one of their settings) are
shown, in this order: **Continue with Google** (white, gray border, the
four-color G; light in dark mode too), **Continue with Apple**
(black, white Apple logo; white in dark mode), **Continue with Microsoft**
(light, gray border, the four-square logo), then the email form with
Turnstile and Restore access. The logos are inline SVG, no images. With
email off there is no email form, no Restore access (it sends an email) and
no "check your email" (the lock card reads "… · Already bought? Sign in"); a
provider that is off has no button; with none at all, "Sign-in is
unavailable right now" instead of buttons. With email alone the sheet looks
as before.

*Checkout through sign-in.* A signed-out sailor who clicks a pass is asked
to sign in, and the pass goes along: in the provider's signed state cookie (Google, Microsoft, Apple), or in
the magic link's stored `return_to` (D1, written only by the server, single
use, 15 minutes). After the callback or the link's confirm, the server
re-validates it (product, `EVENT_ID_RE`) and, unless the user already holds
that pass (bought earlier, or a gift that just attached: the race simply
opens), sends them back to the race with a one-time `buy=` marker: the
intent, the user id and a 10-minute expiry, HMAC-signed with `AUTH_SECRET`.
The page strips the marker from the URL at once and, signed in and not yet
holding the pass, POSTs it with `/api/billing/checkout` once; checkout
accepts a marker only for the session's user, unexpired, for that very
product and event (else 400), and the session and Origin rules apply as for
a click (a held pass is 409: the page re-reads `/me` and unlocks). The page
starts checkout itself (rather than the callback creating the session and
redirecting to Stripe) so there is one checkout path, no Stripe call or
off-site redirect in the sign-in routes, and a forged or stale marker starts
nothing. An event opened with no
`race=` (a bare link, the latest event, a pick in the event menu) lands on
the latest finished race as always, except for a viewer without access to
that regatta: then on race 1 of that race's division, as the server counts
it (`defaultRaceFor` in `src/ui/paywall.ts`), so a first visit opens on the
free race rather than a lock card; the URL names the race shown. The choice
waits for `/api/auth/me` (asked at load; the first race waited for it
already), so there is no flash of the lock card. A link naming a locked race
still shows the lock card.

**Database.** D1 bound as `AUTH_DB`; schema in
`migrations/0001_paywall.sql` (users, sessions, login_tokens, purchases,
entitlements, team_members, stripe_events) and
`migrations/0002_signin_phase1.sql` (sign-in phase 1, additive only:
`sessions` gains `public_id` (backfilled with random hex, unique index),
`last_seen_at` (backfilled with `created_at`), `method`, `revoked_at`,
`revoked_reason` and `revoked_by`; `users` gains `max_sessions` (NULL: the
default, 3); a new `auth_rate_limits` table). **Applying either needs the
owner's OK. Do not run these without it.** Apply 0002 to Preview first,
then to production **before** this code is deployed there: the code reads
the new columns on every signed-in request, so on an unmigrated database
every signed-in request fails (503) and nobody can sign in.

`migrations/0003_identities.sql` (Microsoft and Apple, additive only): a new
`identities` table (provider, subject, user, email, whether it was verified,
Microsoft's tenant, whether it is an Apple relay address, created and last
used; primary key (provider, subject)), backfilled with a `google` row for
every user with a `google_sub`. **DO NOT RUN IT WITHOUT THE OWNER'S OK.**
Apply it (Preview first, then production) **before** any `MICROSOFT_*` or
`APPLE_*` key is set: those sign-ins use this table only. This code can be
deployed before it without changing anything: Google keeps reading and
writing `users.google_sub` as today (its `identities` write is best effort
and fails quietly without the table), and Microsoft and Apple stay hidden,
their routes answering 503 `not_configured`, until their keys exist.

```sh
# DO NOT RUN WITHOUT THE OWNER'S OK
npx wrangler d1 create recall-auth
# then bind it to the Pages project as AUTH_DB (Settings → Bindings → D1 database), Production and Preview
npx wrangler d1 migrations apply recall-auth --remote
```

**Environment** (Pages → Settings → Variables and Secrets; Production and
Preview each):

| Name | Purpose | Secret |
| --- | --- | --- |
| `PAYWALL_ENABLED` | `true` turns the paywall on (default off) | no |
| `AUTH_DB` | D1 binding (not a variable) | — |
| `AUTH_COOKIE_DOMAIN` | cookie domain, default `.walkeforward.com` | no |
| `AUTH_SECRET` | signs the Google, Microsoft and Apple sign-in cookies and the checkout marker (32+ random bytes) | yes |
| `EMAIL_PROVIDER` | `cloudflare-api` (recommended on Pages), `resend` (fallback), `cloudflare` or `log` | no |
| `EMAIL_FROM` | sender, e.g. `Recall <signin@walkeforward.com>` (or a bare address) | no |
| `CF_EMAIL_ACCOUNT_ID` | Cloudflare account id for Email Sending (`cloudflare-api`) | no |
| `CF_EMAIL_API_TOKEN` | an API token with Email Sending send permission (`cloudflare-api`) | yes |
| `RESEND_API_KEY` | Resend API key (`resend`) | yes |
| `EMAIL` | email binding (`cloudflare`; a Worker or service binding, not available to Pages Functions) | — |
| `TURNSTILE_SITE_KEY` | Turnstile widget's site key (email sign-in needs it, except on localhost) | no |
| `TURNSTILE_SECRET_KEY` | Turnstile secret key, for siteverify | yes |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth client (redirect URI `https://recall.walkeforward.com/api/auth/google/callback`) | id no / secret yes |
| `MICROSOFT_CLIENT_ID` | the Entra app's Application (client) ID (redirect URI `https://recall.walkeforward.com/api/auth/microsoft/callback`); needs migration 0003 | no |
| `MICROSOFT_CLIENT_SECRET` | the Entra app's client secret | yes |
| `APPLE_SERVICES_ID` | the Services ID, Apple's `client_id` (return URL `https://recall.walkeforward.com/api/auth/apple/callback`); needs migration 0003 | no |
| `APPLE_TEAM_ID` | the Apple Developer Team ID | no |
| `APPLE_KEY_ID` | the Sign in with Apple key's Key ID | no |
| `APPLE_PRIVATE_KEY` | that key's `.p8` file, the whole PEM (literal `\n` line breaks are fine) | yes |
| `STRIPE_SECRET_KEY` | `sk_test_…` (then live) | yes |
| `STRIPE_WEBHOOK_SECRET` | the webhook endpoint's `whsec_…` | yes |
| `STRIPE_PRICE_REGATTA` | the Regatta Pass price id | no |
| `STRIPE_MANAGED_PAYMENTS` | `off` to leave Managed Payments out (default on) | no |
| `STRIPE_API_VERSION` | sent as `Stripe-Version` when set | no |

Stripe products and prices (test mode first): **Recall Regatta Pass**,
one-time $50 → `STRIPE_PRICE_REGATTA`; **Coach plan**, $499/yr for 6 seats,
optional for now (no checkout yet). The **Recall Season Pass** price is no
longer used (`STRIPE_PRICE_SEASON` may stay set or be removed; nothing reads
it); keep its product in Stripe while any subscription on it runs, so the
existing subscribers renew and can manage it in the portal. What is charged
comes from the price id only; the price on the page (`PRICE_REGATTA` in
`src/ui/paywall.ts`) is copy and must be kept in step by hand.

Webhook endpoint: `https://recall.walkeforward.com/api/billing/webhook`,
events `checkout.session.completed`,
`checkout.session.async_payment_succeeded`, `invoice.paid`,
`customer.subscription.updated`, `customer.subscription.deleted`,
`charge.refunded`.

### Admin: gift passes

A free pass locked to an email address: an all-regattas pass (scope `all`,
or `season`, its stored name: every regatta), or a Regatta Pass for one event
id, with an optional expiry (default none). No codes and no public
endpoint: `scripts/grant-gift.mjs` (node, no dependencies) builds the SQL and
runs it with `npx wrangler d1 execute <db> --remote --command …` (`--local`
for a local D1, `--print` to show the SQL and run nothing; `--db` defaults to
`recall-auth`). These change production data: run them by hand, never from CI.

```sh
# All-regattas pass for an address (no expiry):
node scripts/grant-gift.mjs grant all --email sailor@example.com
# … for a year: through 31 Oct 2027 (UTC), with a note (shown in the output only):
node scripts/grant-gift.mjs grant all --email sailor@example.com --expires 2027-10-31 --note "race committee"
# Regatta Pass for one event:
node scripts/grant-gift.mjs grant regatta --event fDHdPcEOM6mcMRkdXNnj --email sailor@example.com
# Revoke (signed in yet or not; the pass stops unlocking at once):
node scripts/grant-gift.mjs revoke all --email sailor@example.com
node scripts/grant-gift.mjs revoke regatta --event fDHdPcEOM6mcMRkdXNnj --email sailor@example.com
node scripts/grant-gift.mjs revoke --id gift_0123456789abcdef01234567
# Every gift (or one address's): id, email, scope, event, starts, expires, revoked, signed_in (a session not revoked)
node scripts/grant-gift.mjs list
node scripts/grant-gift.mjs list --email sailor@example.com
# Show the SQL only:
node scripts/grant-gift.mjs grant all --email sailor@example.com --print
```

How it works (no migration of its own: grant and revoke use the tables of
`migrations/0001_paywall.sql` only; list also reads `sessions.revoked_at`
from `0002_signin_phase1.sql`): a gift is a `purchases` row (`provider 'gift'`, `provider_ref
'gift:<key>'`, amount 0, status `gift`) and its entitlement, both with the id
`gift_<key>`, where the key comes from the email (lower-cased, trimmed), the
scope and the event id (`all` and `season` are the same gift). They belong to the user with that email, created if
new (as a Stripe webhook does for a buyer with no account), so the pass
unlocks nothing until someone signs in as that very address: a magic link
proves it, and Google, Microsoft and Apple link by it only when they vouch
for it (the rules above), so every session that reaches it proved the
address. An existing user gets it on their next
request. Granting the same gift again changes nothing but its expiry (and
lifts a revocation); revoking twice keeps the first revocation's time.
Inputs are checked strictly (the server's email and event-id patterns; dates
as YYYY-MM-DD, not past) and quoted as SQL strings; wrangler runs without a
shell. The page lists it as "All-regattas pass (gift)", with no Manage
subscription; refunds never touch it; Restore access sends that address a
link. Caveats: the note isn't stored (no column for it); a gift for an
address other than the one a Google-linked account was made with is a
separate account (sign in with a link to that address); `signed_in` in the
list means the address has a session now.

### Admin: signed-in devices

The device cap (3 per account by default) can be changed for one user, and
sessions signed out, by the admin only: `scripts/sessions.mjs` (node, no
dependencies). There is deliberately no API or UI for the cap override. Like
the gift script it builds the SQL and runs it with `npx wrangler d1 execute
<db> --remote --command …` (`--local` for a local D1, `--print` to show the
SQL and run nothing; `--db` defaults to `recall-auth`), needs migration 0002,
and changes production data: run it by hand, never from CI.

```sh
# The user's cap and sessions: public id, method, device, created, last used, expires, revoked and why (no token hashes)
node scripts/sessions.mjs list --email sailor@example.com
# Allow 5 devices at once (1 to 20); applies from their next sign-in
node scripts/sessions.mjs set-cap --email sailor@example.com 5
# Back to the default (3)
node scripts/sessions.mjs set-cap --email sailor@example.com default
# Sign out one session (its public id from list), or every live one
node scripts/sessions.mjs revoke --email sailor@example.com --id 0123456789abcdef01234567
node scripts/sessions.mjs revoke --email sailor@example.com
```

A lowered cap signs nothing out by itself: the user's next sign-in signs out
the least recently used devices beyond it. `revoke` uses the reason `admin`,
so the device is told "You were signed out. Sign in again to keep going."
Inputs are checked strictly (the server's email pattern, public ids as 24
hex characters, caps 1 to 20 or `default`) and quoted as SQL strings;
wrangler runs without a shell.

## Local development

Requires Node 20.19+ (CI uses Node 22).

```sh
npm install
npm run dev        # http://localhost:5173 (Vite proxies /api, /api/telemetry and /api/ys; the dev proxy has no allowlist or stripping)
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
- Deep links: `?event=<eventId>&div=<division>&race=<n>`, optionally with `#start`, `#race` or `#coach` for the tab (`race` is RaceSense's number, or a rebuilt race's `YYYYMMDDHHMM`). `&ys=<Yachtscoring event>`, `&ys=0` or `&ysc=<class>` set the official-results link. Add `&nc=all` to keep coach boats and spare trackers as competitors. By default they are set aside, judged from their event results and tracks (`src/analysis/participation.ts`), not from their names.

**Boat-log uploads locally** (no Cloudflare): `npm run dev:vkx` starts Vite as
usual plus the real `/api/vkx/*` handlers over an in-memory R2 bucket
(`scripts/vkx-dev.mjs`; uploads vanish when it stops).

| Flag | Effect |
| --- | --- |
| `--no-bucket` | shows the "uploads unavailable" state |
| `--feed=fixture` | checks uploads against the committed feed fixture instead of teleapi (USA 833, Fri Sep 11 2026 only) |
| `--fake-finish="USA 833@2026-09-11T13:32:30Z"` | **dev only:** patches the regatta document so J/70 Worlds R7 (no finishes in RaceSense) is listed, for screenshots. Clear localhost's site data afterwards: the patched document sits in Cache Storage. |

`npm run dev` alone has no upload routes, so the button shows "uploads
unavailable". It has no paywall routes either: `/api/auth/me` doesn't answer
`{"paywall":true}` there, so the page reads the paywall as off.

The boat-log fixtures in `tests/fixtures/vkx/` come from
`node scripts/make-vkx-fixture.mjs <log.vkx> <regatta.json> [--ro-feed rows.json]`
(two small teleapi requests). The goldens on the full 10 MB log run when it
is present (`VKX_SAMPLE=/path/to/ro-usa833-2026-09-11.vkx npm test`); the
trimmed fixture's tests always run.

Tests never touch the network. To regenerate the fixture from raw downloads,
run `node scripts/make-fixture.mjs <dir-with-raw-json>`. Add `--preset c31` to
rebuild the C31 Gold Cup race 10 fixture (the data-quality cases), `--preset m24`
or `--preset j88` for the Melges 24 and J/88 ones, and `--preset j105` /
`j105r1` for the J/105 CBC races 2 and 1 (a sparse tracker with a broken
compass). The fixtures keep `roll` and `pitch` (heel and trim) alongside the
position columns, except the J/105 ones.

## Cloudflare Pages setup

1. Create a Pages project connected to this repo.
2. **Build command:** `npm run build`. **Build output directory:** `dist`.
   **Node version:** set `NODE_VERSION=22`.
3. **Functions:** `functions/` is picked up automatically, and
   `functions/api/[[path]].ts` serves `/api/landing`, `/api/regatta`,
   `/api/wind`, `/api/telemetry/event/{id}` and `/api/ys/…`. It only forwards those.
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
   `/api/ys/` goes to `https://api.yachtscoring.com/v1/public/`. GET only, and
   exactly these paths: `event` (search: `name_contains`,
   `startDate_gte`/`_lte` ≤ 62 days apart, `sort`, `size` ≤ 100), `event/:id`,
   `event/:id/splits` (`getAllRows`), `/races` (`size`),
   `/result-detail-report` (`raceNumber`, required), `/cumulative-result`,
   `/boats` (`size`). Ids are numeric, unknown params are dropped, no request
   headers are forwarded, and responses are buffered (2 MB cap) and must be
   JSON. Owner, crew, skipper, contact and similar fields are stripped before
   the response is cached or returned. Cache: searches 1 h; anything else
   7 days once the event has been quiet for 2 days (end date, last start,
   finish and edit), else 5 min; errors are not cached. Yachtscoring sends
   `Access-Control-Allow-Origin: *`, so this route is for the edge cache, the
   stripping and a single origin, not for CORS. No settings change is needed.
4. **No secrets or environment variables are needed** for the app itself.
   The optional Ask Coach chat needs one secret; see
   [Ask Coach (optional)](#ask-coach-optional). The paywall stays off until
   `PAYWALL_ENABLED` is set; see
   [Paywall](#paywall-phase-1-behind-paywall_enabled).
5. Custom domain: `recall.walkeforward.com`.
6. **Boat-log uploads: one R2 bucket, bound as `VKX_BUCKET`** (one-time).
   Until it is bound, uploads show "⚠ uploads unavailable" and nothing else
   changes.
   1. Cloudflare dashboard → **R2 Object Storage** → **Create bucket** →
      name `recall-vkx` (location: Automatic) → Create. R2 may first ask
      you to enable it / add a payment method, even on the free tier.
   2. **Workers & Pages** → the Recall Pages project → **Settings** →
      **Bindings** → **Add** → **R2 bucket** → Variable name `VKX_BUCKET`,
      bucket `recall-vkx`. Do it for **Production** and again for
      **Preview** (each environment has its own bindings; a separate preview
      bucket such as `recall-vkx-preview` keeps test uploads out of
      production).
   3. **Redeploy** (Deployments → latest → Retry deployment, or push).
      Bindings apply to new deployments only.
   4. Check: `https://recall.walkeforward.com/api/vkx/list?event=oRkxbTpSZPbSkrmKrbj2&div=Open`
      returns `{"ok":true,"uploads":[]}` (503 means the binding isn't live).

   CLI equivalent: `npx wrangler r2 bucket create recall-vkx`. The binding
   can then be set in the dashboard as above, or in a `wrangler.toml` (with
   `pages_build_output_dir = "dist"` and
   `[[r2_buckets]] binding = "VKX_BUCKET"`, `bucket_name = "recall-vkx"`).
   A `wrangler.toml` then becomes the source of truth for the project's
   settings, which is why the repo doesn't ship one.

   R2's free tier (10 GB-month of storage, 1 million Class A and 10 million
   Class B operations a month, no egress fees) covers this many times over:
   a race upload is ~0.4 MB and 2–3 operations. Check the current pricing
   page.

   No CORS settings are needed (same-origin), and no public bucket access:
   the bucket is read only through `/api/vkx/data`.

To test the function locally: `npx wrangler pages dev dist` after a build;
`npx wrangler pages dev dist --r2=VKX_BUCKET` adds a local (simulated,
offline) R2 bucket for the upload routes (not run here: wrangler is
intentionally not a dependency; `npm run dev:vkx` covers the same round trip).

## Known gaps (v1)

- Boat-log uploads attach to races the regatta document has. A race RaceSense
  doesn't list (e.g. J/70 Worlds Fri R8) waits for race recovery, and a race
  with no finishes isn't in the picker yet (its upload is stored and shows
  once it is).
- Course order comes from the race committee's course list. Shortened
  courses and moved marks are handled, but unusual courses (offset marks
  rounded as one, reaching starts) may need manual review.
- Wind is assumed uniform across the course at any moment. Shifts are only
  interpolated between beats.
- Fleets of more than 8 boats fall back to neutral boat colors, with sail
  numbers as direct labels.
- Official results come from Yachtscoring only. Sailti (e.g. the J/70 Worlds)
  is a test golden, not a provider. One-design results often carry
  placeholder finish times (J/105 CBC, AYC Fall Series): places are used,
  times aren't.
- The unlinked orphan scan only looks after the last race of a day that has
  fewer races than the busiest day. A missing first race of a day is found
  only when linked, at its official start.
- A rebuilt race has no Vakaros start fixes (DTL comes from the tracks only)
  and no OCS flags.
- A rebuilt race uses the division's RaceSense course list, which can be wrong
  for that day. At Cascais on Wednesday afternoon (official race 4) the listed
  M1/M2 trackers (0x4B1C, 0x4947) sent nothing. The windward mark was tracker
  0x408D, which isn't in the course list, so only the gate is tracked and the
  legs come out as "Beat 1, Run 1". Mapping unlisted trackers to course marks
  is not attempted.
