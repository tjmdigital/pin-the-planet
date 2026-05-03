Pin the Planet

Files:
- index.html
- styles.css
- app.js

Local test:
python3 -m http.server 8000

Then open:
http://localhost:8000

Deploy:
vercel --prod

Important:
Firebase Realtime Database rules must allow reads/writes for /games during your quiz.
Lock the rules down again afterwards.


v32 scoring update

- City mode scoring remains transparent: closer pins score more.
- Any submitted guess now receives at least 50 points.
- Timeout / no guess receives 0 points.
- No closest-guess bonus.
- No accuracy-distance bonus.
- Country mode has been removed from the public setup UI until border/polygon scoring is added.


v33 fix

- Re-applied public rename to Pin the Planet.
- Re-applied join-link mode so ?room=XXXX hides host setup and focuses the join flow.
- Added host-your-own-game secondary action from the join-link screen.
- Preserved v32 scoring update: submitted guesses score at least 50, timeouts score zero, country mode hidden until border-based scoring is added.


v34 setup summary

- Removed the "room link detected" pseudo-label in join-link mode.
- Added dynamic setup summary copy that reacts to rounds, timer, practice, difficulty, map help, tone and scoring selections.


v35 setup panel title

- Renamed the setup summary panel from "Tonight mode" to "Game setup".


v36 short city names

- Added displayName/sourceName split for Wikidata city results.
- Gameplay prompt and reveal now use cleaned short labels, eg "Buffalo City" instead of "Buffalo City Metropolitan Municipality".
- Full source label remains available as sourceName for debugging/future use.


v37 PostHog analytics

- Added PostHog browser snippet to index.html.
- trackEvent now sends events to PostHog via window.posthog.capture().
- Keeps localStorage debug fallback under pinThePlanetEvents.
- Added game_completed once per room and room_abandoned on pagehide.


v38 fixes

- Fixed final screen buttons by ensuring static button IDs and event listeners are present.
- Added delegated click handling for final overlay buttons.
- Improved copy results fallback and tracking.
- Fixed Leaflet attribution overflow so copyright text wraps instead of going off-screen.


v39 Lovable-inspired intro
- Hero-first landing page.
- Create room and play solo as primary actions.
- Settings collapsed behind Customise game.
- Join flow remains direct and room-link aware.
- Future pack UI added with disabled soon states.


v40 polish
- Added loading overlay/spinner while questions are fetched.
- Added background warmup status on home screen.
- createGame now reuses any in-flight prefetch promise rather than starting again.
- Tightened join panel spacing and widened CTA.
- Slightly loosened hero heading letter-spacing.


v41 loading/performance

- Added localStorage cache for warmed question pools, keyed by game setup.
- Cache expires after 30 minutes.
- Background warm-up now fetches up to 25 questions where possible, so follow-up games are more likely to feel instant.
- Game creation now reuses prefetched, cached, or in-flight question pools before falling back to a direct Wikidata call.
- Loading copy now explains that the first load may take a few seconds.


v42 mobile UX refinements

- Reduced mobile overlay and panel text/padding for a tighter in-game layout.
- Added viewport/mobile zoom restriction to reduce Safari page zoom and viewport wobble while pinching the map.
- Added gesture suppression on mobile during gameplay.
- Tightened mobile map/result overlays and status cards.
- Final leaderboard overlay is more full-screen on mobile.
- Hides map zoom controls, map attribution, and the duplicate lower leaderboard while the final mobile leaderboard overlay is visible.
- Disabled double-click, scroll-wheel, and keyboard map zoom on mobile.


v43 silent question warm-up

- Removed visible "Questions ready / cached" status from the landing screen.
- Question warm-up still runs silently in the background.
- Visible loading remains only when the user actively creates a room or starts solo play and the app is still waiting.
- The app warms one pool of up to 25 questions per selected setup, then stops. After that pool is consumed, it warms a fresh one again.


v44 host name visibility

- Moved the host name field onto the main create screen.
- Removed the duplicate host name field from the customise settings drawer.


v45 fixes

- Fixed timed-out rounds so the host can always reveal after the timer hits zero.
- Added a host-side watchdog to close rounds if the render loop misses the exact zero moment.
- Rejoining with the same name in the same room now reuses the existing player record instead of creating a duplicate.
- Moved round spotlight panels higher to reduce overlap with personal result cards.
- Added mobile gesture hardening and viewport lock to reduce Safari zoom/window wobble during map interactions.
- Hides map controls/attribution and duplicate lower leaderboard while the final mobile leaderboard overlay is active.


v46 changes

- Solo mode now presents as a dedicated solo run rather than a one-person leaderboard.
- Room code label changes to Mode in solo games.
- Host controls label changes to Solo controls.
- Solo running total panel now uses Your score so far / Solo run complete language.
- Live Current round list is hidden in solo mode until reveal.
- Solo reveal shows a dedicated Your round result card.
- Final overlay in solo mode now shows a solo summary card and Play solo again CTA.


v47 solo best runs

- Solo mode now stores best runs in localStorage under pinThePlanetSoloBests.
- Bests are keyed by question type, city difficulty, map mode, scoring mode, round count and practice setting.
- Tone is not part of the score key because it does not affect difficulty.
- Final solo overlay now shows score percentage and best-for-this-setup.
- PostHog events added/updated:
  - solo_game_completed
  - solo_best_set
  - solo_second_run_started


v48 solo/multiplayer polish

- Reworked solo text so it no longer talks about hosts/everyone guessing.
- Solo live state now says "place or change your pin before time runs out".
- Solo reveal state says "score your round" / "your score".
- Start/next round now scrolls the mobile viewport back to the top so the Get Ready/question panel is visible.
- Hide map zoom controls and attribution during revealed states on mobile so they do not overlay result/spotlight panels.
- Hide round spotlight overlay entirely in solo mode.


v49 mobile landing order

- On normal mobile visits, the main hero/create screen now appears before the Got a code join panel.
- In shared-room link mode (?room=XXXX), the join panel still takes priority.


v50 map overlay safe spacing

- Added final safe-inset CSS rules for the map question panel.
- Ensures the question/reveal panel never sits flush against map edges on desktop or mobile.
- Applied the same inset logic to spotlight and personal result overlays.
- Final leaderboard keeps full-screen behaviour on mobile.


v51 Level 1 question API

- Added Vercel serverless route: /api/questions.
- Browser now requests question sets from the API instead of carrying question-generation logic in app.js.
- Future 500+ familiar city pool can live in /api/questions.js or a server-side data file without being visible in browser source.
- This is Level 1: the full pool is hidden from frontend source, but selected answers are still sent to the client/Firebase for the current game.
- Familiar mode is anchored by a server-side recognisable seed list plus Wikidata top-up.
- Mixed mode is mostly recognisable cities with some Wikidata wildcards.
- Chaos mode remains Wikidata-led.


v52 familiar city expansion

- Expanded the server-side curated familiar seed pool to 338 cities.
- Familiar mode now uses the curated server-side pool only, rather than topping up with Wikidata.
- This prevents obscure Wikidata cities/municipalities appearing in Familiar mode.
- Mixed mode remains mostly curated with some Wikidata wildcards.
- Chaos mode remains Wikidata-led.
- Future work: move the curated pool into a separate server-side data file and expand towards 500+ cities.


v53 QA fixes

- Rejoining with the same name now reuses the existing player record where possible and removes stale duplicate records.
- New rounds include only online, de-duplicated players so offline duplicates cannot block a game.
- Player list collapses duplicate names for display and marks offline players as ignored next round.
- Timer made visually more prominent, especially on mobile and when hot.
- Setup summary warns when 10 seconds is selected because it is intentionally frantic.
- Added optional in-app debug panel for testers: append ?debug=1 to the URL.


v54 API fallback fix

- Fixed /api/questions 500 risk by making mixed/chaos generation fall back to the curated server-side pool if Wikidata fails or returns too few usable cities.
- pickOneCityPerCountry now falls back to allowing repeat countries rather than throwing if a pool is unexpectedly too small.
- Familiar mode remains curated-only.
- Mixed mode remains mostly curated with Wikidata wildcards when available.
- Chaos mode is Wikidata-led but no longer hard-fails if Wikidata is unavailable.


v55 mode contract clarification

- Familiar mode = server-side curated API content only. It does not depend on Wikidata.
- Mixed mode = mostly server-side curated cities, plus Wikidata curveballs where available.
- Chaos mode = Wikidata-led, but falls back to curated questions rather than returning 500.
- Expanded the server-side familiar seed list further.
- Added final API safety net so /api/questions returns a playable set instead of failing hard.


v56 question API reliability

- Removed Wikidata dependency from Mixed mode.
- Familiar = curated server-side pool only.
- Mixed = curated server-side pool only for now, to keep room creation reliable.
- Chaos = tries Wikidata with a short timeout, then falls back to curated.
- /api/questions now has an emergency fallback that returns a playable curated set rather than 500 for normal inputs.


v57 optional Wikidata done properly

- Familiar = curated server-side pool only.
- Mixed = mostly curated server-side cities plus optional Wikidata wildcard cities when Wikidata responds quickly.
- Chaos = Wikidata-led with curated fallback.
- Wikidata is now treated as an optional freshness source, never a blocker for room creation.
- Added timeout and User-Agent for Wikidata requests.
- Removed heavy random OFFSET behaviour from the SPARQL query.
- Added /api/questions-debug endpoint for inspecting debug payloads.
- /api/questions response includes debug/source metadata to help verify which mode was used.


v58 API runtime hardening

- Replaced /api/questions with a compact runtime-safe implementation.
- Emergency fallback no longer depends on any Wikidata path.
- Mixed mode still attempts optional Wikidata wildcard cities, but cannot fail room creation.
- Added /api/questions-debug endpoint.


v59 solo entry hardening

- Play solo is explicitly a button that calls createGame(true), never a /solo route.
- Added optional direct solo entry via ?mode=solo or ?solo=1 for testers.
- Solo mode sets singlePlayer: true in game state.
- Solo UI hides copy link and players list, labels the mode as SOLO RUN and uses Solo controls.
- Solo copy avoids host/everyone language in key game states.


v60 QA follow-up

- Brand/logo home link reinforced.
- /api/questions now accepts both cityDifficulty and difficulty query params.
- /api/questions-debug route included.
- Join flow now only restores localStorage session if entered name matches the saved player name.
- Added "Join as a different player on this browser" option for same-browser testing.
- Added visible ?debug=1 debug panel if not already present.
- Hardened copy-results spacing around the tagline.


v61 best/worst distance fix

- Fixed best guess / roast of the round being wrong when multiple players hit the minimum score floor.
- Best guess and wooden spoon are now based on distance, not points.
- Score sorting still uses points, with distance as a tie-breaker.
- Map marker best/worst styling now uses distance ranking.


v62 report follow-up fixes

- Solo mode now defaults player name to "You" if the host name field still says "Quiz host".
- Solo display labels show the current solo player as "You".
- Final leaderboard overlay now hides Leaflet zoom controls and attribution globally, not just under some mobile rules.
- API difficulty parsing is case-safe and accepts both cityDifficulty and difficulty query params.
- Added a non-host status message if the host disconnects mid-game.


v63 API hardening

- Replaced the question API with a runtime-tested version.
- Verified locally that familiar, mixed and chaos each return status 200, correct difficulty and correct count.
- Verified that difficulty=chaos alias is honoured.
- Familiar remains curated-only.
- Mixed uses curated + optional Wikidata wildcard.
- Chaos uses Wikidata with curated fallback.


v64 version/copy diagnostics

- Frontend exposes window.PTP_VERSION = v64-version-copy.
- /api/questions response includes apiVersion = v64-question-api.
- Copy link now builds a clean room URL from origin/path and ?room=CODE.
- Copy link has a prompt fallback if Clipboard API fails.
- Copy results uses the same clipboard fallback.
- Debug panel includes app version and current join URL.

v67 country mode

- Adds Country mode alongside city modes. /api/questions accepts
  questionType=country and returns simplified per-country geometry.
- Country scoring is client-side: pin inside the polygon = 1000;
  otherwise score = max(50, round(1000 * exp(-distanceToBorderKm / 1200))).
- Familiar/mixed/chaos city pools are unchanged and still static.

Country boundary data
- data/countries.geojson is built from Natural Earth 1:110m admin 0
  countries. Natural Earth data is in the public domain. Source:
  https://github.com/nvkelso/natural-earth-vector
- The build script lives at scripts/build-countries.js and slims the
  raw Natural Earth file to ~200KB by stripping unused properties and
  rounding coordinates to 3 decimal places.
