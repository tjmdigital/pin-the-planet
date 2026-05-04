import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getDatabase,
  ref,
  set,
  update,
  onValue,
  get,
  remove,
  onDisconnect,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyCVKLEbaCyo-Uo66aa1AUsDgOBXCv-YGHw",
  authDomain: "world-pin-quiz.firebaseapp.com",
  projectId: "world-pin-quiz",
  storageBucket: "world-pin-quiz.firebasestorage.app",
  messagingSenderId: "991176101907",
  appId: "1:991176101907:web:3457b71d200e775f566fe6",
  databaseURL: "https://world-pin-quiz-default-rtdb.europe-west1.firebasedatabase.app/"
};

const PTP_APP_VERSION = "v86-human-dates";
window.PTP_VERSION = PTP_APP_VERSION;

const isFirebaseConfigured = firebaseConfig.apiKey && firebaseConfig.apiKey !== "PASTE_HERE" && firebaseConfig.databaseURL;
let app = null;
let db = null;

if (isFirebaseConfigured) {
  app = initializeApp(firebaseConfig);
  db = getDatabase(app);
  document.getElementById("connectionStatus").textContent = "Online sync ready";
} else {
  document.getElementById("connectionStatus").textContent = "Firebase needed";
  document.getElementById("firebaseWarning").classList.remove("hidden");
}

const $ = (id) => document.getElementById(id);

const state = {
  gameCode: null,
  playerId: null,
  playerName: null,
  isHost: false,
  game: null,
  map: null,
  guessMarker: null,
  answerMarker: null,
  renderCache: {},
  guessLines: [],
  revealMarkers: [],
  selectedGuess: null,
  autoClosingRoundKey: null,
  finalOverlayVisibleKey: null,
  finalOverlayPendingKey: null,
  finalOverlayTimer: null,
  prefetchedQuestions: null,
  prefetchedCount: 0,
  prefetchPromise: null,
  prefetchKey: null,
  baseLayer: null,
  baseMapMode: null
};

function getTrafficSource() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("room")) return "shared_link";
  if (document.referrer) return "referral";
  return "direct";
}

function trackEvent(name, data = {}) {
  const payload = {
    ...data,
    source: typeof getTrafficSource === "function" ? getTrafficSource() : "unknown",
    host_or_player: state.isHost ? "host" : "player",
    single_player: Boolean(state.game?.singlePlayer),
    app_version: PTP_APP_VERSION
  };

  try {
    if (window.posthog?.capture) {
      window.posthog.capture(name, payload);
    }

    const existing = JSON.parse(localStorage.getItem("pinThePlanetEvents") || "[]");
    existing.push({ name, data: payload, ts: Date.now() });
    localStorage.setItem("pinThePlanetEvents", JSON.stringify(existing.slice(-100)));
  } catch (error) {
    // Analytics must never break gameplay.
  }
}

function currentAbandonStage() {
  if (!state.game) return "home";
  if (!state.game.started) return "lobby";
  if (state.game.revealed && typeof isFinalRevealState === "function" && isFinalRevealState()) return "final_screen";
  if (state.game.revealed) return "between_rounds";
  return "mid_round";
}

function trackRoomAbandoned() {
  if (!state.gameCode || !state.game) return;
  trackEvent("room_abandoned", {
    code: state.gameCode,
    stage: currentAbandonStage(),
    round: state.game.currentRound,
    completed_round_count: state.game.revealed ? state.game.currentRound + 1 : state.game.currentRound,
    player_count: typeof playersArray === "function" ? playersArray().length : null
  });
}


const markerIcons = {
  guess: L.divIcon({ className: "guess-marker" }),
  answer: L.divIcon({
    className: "answer-marker",
    html: `<div class="answer-pin">✓</div>`,
    iconSize: [38, 38],
    iconAnchor: [19, 19]
  })
};

const uid = () => Math.random().toString(36).slice(2, 10);
const roomCode = () => Math.random().toString(36).slice(2, 6).toUpperCase();

const AVATARS = ["🍺", "🦉", "🧭", "🗺️", "🐐", "🦆", "🍕", "🎯", "🦍", "🦥", "🥸", "🚕", "🛶", "🦖", "🍟", "🏴‍☠️"];
const QUESTION_CACHE_TTL_MS = 30 * 60 * 1000;
const QUESTION_WARM_POOL_SIZE = 25; // One silent background pool per setup. Re-warms after a game consumes it.
const ROUND_DURATION_SECONDS = 30;
const MIN_SUBMITTED_SCORE = 50;


function randomAvatar() {
  return AVATARS[Math.floor(Math.random() * AVATARS.length)];
}

// Picks an avatar that none of the existing players in `game` already
// use. Falls back to a random one if every avatar is already taken
// (more players than emojis in AVATARS).
function pickUniqueAvatar(game) {
  const taken = new Set();
  const players = game?.players || {};
  for (const id of Object.keys(players)) {
    const a = players[id]?.avatar;
    if (a) taken.add(a);
  }
  const free = AVATARS.filter(a => !taken.has(a));
  const pool = free.length ? free : AVATARS;
  return pool[Math.floor(Math.random() * pool.length)];
}

function randomFrom(options, seed) {
  return options[Math.abs(Math.floor(seed || 0)) % options.length];
}

function verdictForDistance(distanceKm) {
  const tone = currentToneMode();
  if (!Number.isFinite(distanceKm)) {
    if (tone === "school") return randomFrom([
      "No guess this time. Try to make a sensible estimate next round.",
      "No pin submitted. Use the reveal to learn the location.",
      "Empty pin this round. The map is a tool - use it next time.",
      "No estimate this time. Have a look at the answer for next round."
    ], 0);
    if (tone === "friendly") return randomFrom([
      "No guess submitted this time.",
      "No pin this round. Plenty more to come.",
      "Missed the timer. The next round resets it.",
      "No guess - we’ve all been there."
    ], 0);
    return randomFrom([
      "No guess. Bottle job.",
      "Didn’t pin. Stunning lack of commitment.",
      "Empty round. Inspirational stuff.",
      "Couldn’t even commit to wrong.",
      "Pin abstention noted by the committee.",
      "Zero pin, zero point. Take a hard look."
    ], 0);
  }

  if (tone === "school") {
    if (distanceKm < 75) return randomFrom([
      "Excellent work. That is a very accurate estimate.",
      "Outstanding placement. You clearly knew this one.",
      "Top-quality pin. Very precise.",
      "Strong geographical reasoning. Great pin."
    ], distanceKm);
    if (distanceKm < 300) return randomFrom([
      "Very close. You clearly knew the right region.",
      "Strong estimate within the broader region.",
      "A confident regional placement. Well reasoned.",
      "Close enough to count as a strong answer."
    ], distanceKm);
    if (distanceKm < 1000) return randomFrom([
      "Good effort. You were in the right broad area.",
      "Decent placement. Right part of the world.",
      "Reasonable pin. Continent-level accuracy.",
      "Right area, even if the city slipped past."
    ], distanceKm);
    if (distanceKm < 3000) return randomFrom([
      "Not quite, but your guess gives you a useful clue for next time.",
      "Some way off, but a useful learning point.",
      "Wrong region, but a fair attempt.",
      "Not on target, but an honest estimate."
    ], distanceKm);
    return randomFrom([
      "That was a long way off, but the reveal is a good chance to learn the location.",
      "Quite a distance off. The reveal should help next time.",
      "A long way off. Worth studying the answer.",
      "Far from the answer - the reveal is the lesson here."
    ], distanceKm);
  }

  if (tone === "friendly") {
    if (distanceKm < 75) return randomFrom([
      "Brilliant guess. Very nicely done.",
      "Top pin. Lovely work.",
      "Spot on. Beautifully placed.",
      "Pinpoint. Take a bow.",
      "Properly accurate. Well played.",
      "Sharp eye. Excellent pin."
    ], distanceKm);
    if (distanceKm < 300) return randomFrom([
      "Strong effort. That was close.",
      "Lovely pin. Right neighbourhood.",
      "Great regional placement.",
      "Very respectable. Well done.",
      "Tidy bit of pinning."
    ], distanceKm);
    if (distanceKm < 1000) return randomFrom([
      "Decent guess. Points on the board.",
      "Solid effort. Right general area.",
      "Reasonable pin. Score banked.",
      "Not bad at all. Onwards.",
      "Decent stab at it. Points logged."
    ], distanceKm);
    if (distanceKm < 3000) return randomFrom([
      "A brave guess. Not quite there.",
      "Bold pin. Slightly off the mark.",
      "Wrong region, but a confident attempt.",
      "Plenty of pin, less of a clue.",
      "Hopeful pin. Onwards to the next."
    ], distanceKm);
    return randomFrom([
      "A long way off, but at least you committed.",
      "Big swing. The map shrugged.",
      "Far away, but no shame in trying.",
      "Brave commitment. Sadly the wrong continent.",
      "Bold attempt. The reveal will surprise you."
    ], distanceKm);
  }

  const bands = [
    { max: 20, lines: [
      "Ridiculous. Studied or cheated.",
      "Practically sat outside the town hall.",
      "Suspiciously good. Check his tabs.",
      "That is smug WhatsApp behaviour.",
      "Filthy. Absolutely filthy.",
      "That is annoyingly elite geography.",
      "You’ve either been there or you’re lying.",
      "Borderline forensic. Horrible stuff.",
      "That pin is a confession. Lock him up.",
      "Pinpoint accuracy. Genuinely upsetting.",
      "Disgustingly close. Nobody asked for this.",
      "Surgical. The rest of us are crying."
    ]},
    { max: 75, lines: [
      "Basically in the right pub.",
      "Annoyingly accurate.",
      "Very tidy. Nobody likes a swot.",
      "That one will be mentioned again later.",
      "Close enough to start acting unbearable.",
      "A properly sharp guess, unfortunately.",
      "Very strong. Sickening, really.",
      "That’s the kind of guess that ruins friendships.",
      "Top-tier pinning. Insufferable.",
      "Within walking distance of correct. Awful.",
      "Sharp work. Cue the smug face.",
      "Absurdly close. He’ll be insufferable for hours."
    ]},
    { max: 200, lines: [
      "Very respectable. Horrible to admit.",
      "Close enough to pretend he knew it.",
      "Solid geography dad energy.",
      "He will now act like this was easy.",
      "Strong effort. Smugness incoming.",
      "You can dine out on that for at least a week.",
      "Very decent. Deeply irritating.",
      "Close enough for boastful retellings.",
      "Quietly excellent. Loudly annoying.",
      "Same county energy. Worryingly competent.",
      "Disturbingly tidy work.",
      "He’ll bring this up at three weddings."
    ]},
    { max: 500, lines: [
      "Same general area. We’ll allow it.",
      "Not bad after three beers.",
      "Close-ish. Confidence did the work.",
      "Good enough to be irritating.",
      "A respectable lash at it.",
      "Plenty of guessers would have killed for that.",
      "Not perfect, but more than good enough.",
      "That’ll do nicely in a pub quiz.",
      "Same time zone, near enough.",
      "Solid guess. Won’t change his life, but here we are.",
      "A pin with manners.",
      "Acceptable in a court of law."
    ]},
    { max: 1000, lines: [
      "Not awful, not clever.",
      "Geography GCSE muscle memory kicking in.",
      "Acceptable pub quiz guesswork.",
      "More luck than judgement, but points are points.",
      "A serviceable guess from a serviceable man.",
      "Decent enough. No medals, no shame.",
      "Competent, which feels almost suspicious.",
      "Close enough to avoid public ridicule.",
      "Pin with mid-table energy.",
      "An honest middle-of-the-road effort.",
      "Wouldn’t win a quiz, wouldn’t lose it either.",
      "That pin has a beige personality."
    ]},
    { max: 2000, lines: [
      "Confidently adjacent to reality.",
      "Wrong, but in a thoughtful way.",
      "You’ll defend that for ten minutes.",
      "A near miss if you squint dramatically.",
      "Not right, but not fully embarrassing either.",
      "There was a shape to the logic. Sadly not much more.",
      "A respectable miss. Still a miss.",
      "You were circling the drain of correctness.",
      "A wrong pin with a confident face.",
      "Wrong, but with conviction.",
      "Plausible nonsense.",
      "A miss with a press release."
    ]},
    { max: 4000, lines: [
      "Same planet, at least.",
      "There was a theory. It was wrong.",
      "A brave interpretation of the question.",
      "Geography by vibes alone.",
      "You’ve mistaken confidence for accuracy.",
      "Somewhere between hopeful and clueless.",
      "Wrong enough to raise eyebrows.",
      "Pin acted on intuition. Intuition was drunk.",
      "Geography filed under fiction.",
      "Confidence: 100. Map use: 0.",
      "That pin had ambition, not evidence."
    ]},
    { max: 8000, lines: [
      "A bold misunderstanding of geography.",
      "Maps were available, but not apparently useful.",
      "This is why we cannot have nice things.",
      "Huge confidence. Zero evidence.",
      "An absolute hostage situation of a guess.",
      "That is catastrophically unwell geography.",
      "You’ve treated the globe like a dartboard.",
      "The pin is wandering about unsupervised.",
      "A pin with no fixed abode.",
      "An emotional decision, not a geographical one.",
      "Pin disowned by science.",
      "A guess that needs counselling."
    ]},
    { max: Infinity, lines: [
      "Wrong hemisphere. Tremendous work.",
      "Does he know what a city is?",
      "That guess needs a written apology.",
      "The map has been used mainly as decoration.",
      "At that point it’s less a guess, more a cry for help.",
      "You’ve gone so wrong it feels personal.",
      "That belongs in The Hague.",
      "An absolute war crime of a pin.",
      "Pin lost in space and time.",
      "A guess with its own gravitational field.",
      "Genuinely landmark wrongness.",
      "That pin will be studied for generations."
    ]}
  ];

  const band = bands.find(item => distanceKm < item.max);
  return randomFrom(band.lines, distanceKm);
}

function bestSpotlightCopy(distanceKm) {
  const tone = currentToneMode();
  if (tone === "school") return randomFrom([
    "Best estimate this round. Excellent use of map knowledge.",
    "Top mark for the round. Strong reasoning.",
    "Closest pin of the round. Well done.",
    "A precise estimate. Geography skills paying off."
  ], distanceKm);
  if (tone === "friendly") return randomFrom([
    "Best guess of the round. Nicely done.",
    "Top of the pile. Great pin.",
    "Lovely work. Round winner.",
    "Closest pin of the round. Smart stuff.",
    "Proper sharp. Well played.",
    "Best of the lot. Take a bow."
  ], distanceKm);
  if (!Number.isFinite(distanceKm)) return randomFrom([
    "No idea how he’s won that, but here we are.",
    "Won by default. Stunning lack of competition.",
    "Crowned champion of the empty field."
  ], distanceKm);
  if (distanceKm < 50) return randomFrom([
    "Absolutely obscene. Investigate immediately.",
    "That is elite behaviour. Sickening stuff.",
    "A monstrous guess. Everyone hates this.",
    "Forensic. Suspicious. Absolutely filthy.",
    "Not a guess, a confession. Genuinely upsetting.",
    "Annoyingly perfect. The smugness will be unbearable.",
    "That pin is a war crime against the rest of the field."
  ], distanceKm);
  if (distanceKm < 250) return randomFrom([
    "Very sharp. He’ll be unbearable about that.",
    "Excellent work, sadly.",
    "That’s properly good and deeply annoying.",
    "Annoyingly close. Cue the smug grin.",
    "Disgustingly accurate. Apologies to your friends.",
    "Top-tier pinning. Insufferable.",
    "Genuinely sharp. Bravo. Reluctantly."
  ], distanceKm);
  if (distanceKm < 1000) return randomFrom([
    "Best of the lot. Pub-quiz royalty for one round.",
    "A decent bit of work in a sea of confusion.",
    "Strong enough to earn smug rights.",
    "Solid pinning. Crown for the round.",
    "Decent work in a weak field.",
    "Heroically average, but the best heroically average.",
    "A worthy round winner. For now."
  ], distanceKm);
  return randomFrom([
    "Not brilliant, but still enough to win this circus.",
    "Best of a scruffy bunch.",
    "He’s won, which says worrying things about the field.",
    "Tallest dwarf of the round.",
    "Won by being the least wrong.",
    "Champion of a deeply mediocre round.",
    "The least embarrassing pin. Take what you can."
  ], distanceKm);
}

function worstSpotlightCopy(distanceKm) {
  const tone = currentToneMode();
  if (tone === "school") return randomFrom([
    "Most room for improvement this round. The reveal should help.",
    "A long way off this time. Use the reveal to learn the location.",
    "Tough round. The reveal will help next time.",
    "Try sketching mental regions before committing the pin."
  ], distanceKm);
  if (tone === "friendly") return randomFrom([
    "Tough one. There is always the next round.",
    "Bit of a swing and a miss. Onwards.",
    "Not your round. The next one is yours.",
    "Brave attempt. The map giveth and taketh away.",
    "Tricky one. Don’t let it ruin the rest of the game."
  ], distanceKm);
  if (!Number.isFinite(distanceKm)) return randomFrom([
    "Didn’t even submit. Bottle job of the round.",
    "No pin, no points. Stunning commitment to nothing.",
    "Couldn’t even commit to wrong.",
    "A pin abstention. Genuinely shameful."
  ], distanceKm);
  if (distanceKm < 1000) return randomFrom([
    "Harsh to roast this, but someone has to finish last.",
    "Unlucky. A decent guess in a stronger field.",
    "Not a disaster - just not good enough.",
    "Saved by the proximity, ruined by the company.",
    "Decent miss. Bad luck on the field.",
    "Was almost respectable. Almost."
  ], distanceKm);
  if (distanceKm < 4000) return randomFrom([
    "There was a method. Shame about the result.",
    "An imaginative pin with tragic consequences.",
    "Wrong in a way that felt avoidable.",
    "Confidence: 10. Accuracy: criminal.",
    "Whatever the logic was, it has been arrested.",
    "A stinker dressed up as a strategy.",
    "Geography by horoscope, apparently."
  ], distanceKm);
  return randomFrom([
    "Absolutely appalling. A landmark performance in being wrong.",
    "That pin should be confiscated.",
    "A generational stinker of a guess.",
    "Wrong continent, wrong instincts, wrong vibes.",
    "An apocalyptic pin. Frame it.",
    "That guess will be discussed for years.",
    "A historic moment in the wrong direction."
  ], distanceKm);
}

// --- Country-mode-specific feedback ---------------------------------------

function countryVerdictCopy(row) {
  const tone = currentToneMode();
  const inside = row.inside;
  const km = row.distance;

  if (!row.hasGuess || !Number.isFinite(km)) {
    if (tone === "school") return "No guess submitted. Take a moment with the reveal to find the country.";
    if (tone === "friendly") return "No guess this round. Plenty more rounds to come.";
    return randomFrom([
      "No guess. Even a wild jab beats this.",
      "Didn’t pin a thing. Inspired commitment to nothing.",
      "Empty pin energy. Bottle job."
    ], 0);
  }

  if (inside) {
    // The row already shows "Inside the country" as the distance label.
    // Keep these to just the praise so we don't end up reading "Inside
    // the country - Inside the country. <praise>".
    if (tone === "school") return randomFrom([
      "Excellent placement.",
      "Great work.",
      "Clean hit. Maximum points.",
      "Pinpoint geography."
    ], km);
    if (tone === "friendly") return randomFrom([
      "Lovely pin.",
      "Top score.",
      "Right in the middle of it.",
      "Full marks.",
      "Nailed it.",
      "Bang on."
    ], km);
    return randomFrom([
      "Filthy precision.",
      "Insufferable.",
      "Annoying, frankly.",
      "Smug rights granted.",
      "Investigate immediately.",
      "Genuinely upsetting accuracy."
    ], km);
  }

  if (tone === "school") {
    if (km < 100) return "Very close to the border. Strong placement.";
    if (km < 500) return "Right region, just outside the country.";
    if (km < 1500) return "Same broad area. The reveal should help next time.";
    if (km < 4000) return "Wrong region but useful learning. Check the reveal.";
    return "A long way off. The reveal is the place to learn.";
  }
  if (tone === "friendly") {
    if (km < 100) return "Just outside the border. Heartbreaker.";
    if (km < 500) return "Right area. Country slipped past you.";
    if (km < 1500) return "Same continent vibes. Decent stab.";
    if (km < 4000) return "Wrong region, but it happens.";
    return "A bold pin in the wrong direction. We move on.";
  }
  if (km < 100) return randomFrom([
    "Just outside the border. Tragic.",
    "Touching the line and still wrong.",
    "Heartbreakingly close. The map doesn’t care.",
    "A pin that died on the doorstep."
  ], km);
  if (km < 500) return randomFrom([
    "Right area. Wrong country.",
    "Geography at the regional level. Borders at the catastrophic level.",
    "Knew the neighbourhood, missed the house.",
    "Close-ish. Doesn’t pay the bills."
  ], km);
  if (km < 1500) return randomFrom([
    "Same continent. Different country. Different millennium.",
    "Got the shape of it. Forgot the country.",
    "A confident regional miss.",
    "Wrong country, but the right general mood."
  ], km);
  if (km < 4000) return randomFrom([
    "Wrong region. Bold attempt.",
    "Right ballpark, wrong country.",
    "Geography by guesswork.",
    "A pin with ambition and nothing else.",
    "Way off, but the continent gods may forgive you.",
    "Confidently far. Confidently wrong."
  ], km);
  if (km < 8000) return randomFrom([
    "Wrong continent energy.",
    "That pin needs a passport.",
    "Spectacularly off-region.",
    "A pin with no fixed abode.",
    "Geography by horoscope."
  ], km);
  return randomFrom([
    "Wrong hemisphere. Iconic.",
    "That’s not a guess, that’s a cry for help.",
    "Pin lost in space and time.",
    "A guess that needs an apology and a globe.",
    "Spectacularly wrong. Everyone’s impressed in a bad way."
  ], km);
}

function countryBestSpotlight(row) {
  const tone = currentToneMode();
  if (tone === "school") return row.inside ? "Pin landed inside the country. Excellent work." : "Closest to the border. Strong reasoning.";
  if (tone === "friendly") return row.inside ? "Pinned inside the country. Top job." : "Closest to the border. Nicely done.";
  if (row.inside) return randomFrom([
    "Pin in the country. Smug rights granted.",
    "Inside the borders. Insufferable.",
    "Bang inside. Investigate immediately.",
    "Forensic country pinning. Disgusting work.",
    "Inside the lines. He’ll mention it for a week."
  ], row.distance);
  if (row.distance < 200) return randomFrom([
    "Couldn’t quite get inside, but heroically close.",
    "Pinned the border. Award energy.",
    "Best of a near-miss field."
  ], row.distance);
  return randomFrom([
    "Best pin in a confused field.",
    "Won by being the least lost.",
    "Champion of a regrettable round."
  ], row.distance);
}

function countryWorstSpotlight(row) {
  const tone = currentToneMode();
  if (tone === "school") return Number.isFinite(row.distance) ? "Furthest pin from the country. The reveal should help." : "No guess submitted. Use the reveal to learn the location.";
  if (tone === "friendly") return Number.isFinite(row.distance) ? "Tricky one. The next round is yours." : "No guess. Onwards.";
  if (!Number.isFinite(row.distance)) return randomFrom([
    "Didn’t even pin a country. Stunning.",
    "No pin, no country, no chance.",
    "An empty round. Inspirational."
  ], 0);
  if (row.distance < 1500) return randomFrom([
    "Harsh roast - decent miss in a strong field.",
    "Wrong country, but at least the right region.",
    "Bad luck more than bad pin."
  ], row.distance);
  if (row.distance < 4000) return randomFrom([
    "Wrong region. Wrong country. Right confidence.",
    "A miss with character.",
    "Wrong continent energy."
  ], row.distance);
  return randomFrom([
    "Wrong hemisphere. Iconic.",
    "That pin needs a passport and an apology.",
    "Spectacular geographical fiction.",
    "A pin lost in international waters."
  ], row.distance);
}

function verdictForRow(row, question) {
  if (question?.type === "country") return countryVerdictCopy(row || { hasGuess: false });
  if (!row?.hasGuess) return verdictForDistance(Infinity);
  return verdictForDistance(row.distance);
}

function bestSpotlightForRow(row, question) {
  if (question?.type === "country") return countryBestSpotlight(row);
  return bestSpotlightCopy(row.distance);
}

function worstSpotlightForRow(row, question) {
  if (question?.type === "country") return countryWorstSpotlight(row);
  return worstSpotlightCopy(row.distance);
}

function escapeHtml(input) {
  return String(input || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function displayPlayerName(player) {
  const raw = String(player?.name || "").trim();
  // Solo: only fall back to "You" when the player didn't set a real
  // name (empty or generic placeholders). If they typed something
  // distinctive it's used everywhere, including share text and any
  // future leaderboard.
  if (isSoloGame?.() && player?.id === state.playerId) {
    if (!raw || /^(you|quiz host|player)$/i.test(raw)) return "You";
    return raw;
  }
  return raw || "Player";
}

function playerLabel(player) {
  return `${player.avatar || "🌍"} ${escapeHtml(displayPlayerName(player))}`;
}

function cleanLocationDisplayName(name = "") {
  return String(name)
    .replace(/\s+Metropolitan Municipality$/i, "")
    .replace(/\s+Metropolitan District Municipality$/i, "")
    .replace(/\s+Local Municipality$/i, "")
    .replace(/\s+District Municipality$/i, "")
    .replace(/\s+Municipality$/i, "")
    .replace(/\s+City Municipality$/i, " City")
    .replace(/\s+\(.*?\)$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function locationDisplayName(question) {
  return cleanLocationDisplayName(question?.displayName || question?.city || question?.name || "");
}

function markerName(player) {
  const name = String(player?.name || "");
  return name.length > 12 ? `${name.slice(0, 11)}…` : name;
}





function setVisible(el, visible) {
  if (!el) return;
  el.classList.toggle("hidden", !visible);
}

function setHtmlIfChanged(el, html, cacheKey = null) {
  if (!el) return;
  const key = cacheKey || el.id || "anonymous";
  if (state.renderCache[key] === html) return;
  state.renderCache[key] = html;
  el.innerHTML = html;
}

function getSetupOptions() {
  const practiceEnabled = $("practiceRound")?.value === "on";
  const rawRounds = Number($("roundCount")?.value);
  const roundsRequested = clamp(Number.isFinite(rawRounds) && rawRounds > 0 ? rawRounds : 10, 1, 20);
  const rawDuration = Number($("roundDuration")?.value);
  const roundDurationSeconds = clamp(Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : ROUND_DURATION_SECONDS, 10, 60);
  return {
    roundsRequested,
    roundDurationSeconds,
    practiceEnabled,
    questionType: $("questionType")?.value === "country" ? "country" : "city",
    cityDifficulty: $("cityDifficulty")?.value || "mixed",
    mapMode: $("mapMode")?.value || "hardcore",
    toneMode: $("toneMode")?.value || "lads",
    scoringMode: $("scoringMode")?.value || "distance"
  };
}

function optionsKey(options) {
  return `${options.questionType || "city"}|${options.cityDifficulty || "mixed"}|${options.practiceEnabled ? "practice" : "no-practice"}|${options.roundsRequested || 10}`;
}

function questionCacheStorageKey(options) {
  return `pinThePlanetQuestions:${optionsKey(options)}`;
}

function readCachedQuestions(options, minCount) {
  try {
    const raw = localStorage.getItem(questionCacheStorageKey(options));
    if (!raw) return null;

    const cached = JSON.parse(raw);
    if (!cached?.questions?.length || !cached?.createdAt) return null;
    if (Date.now() - cached.createdAt > QUESTION_CACHE_TTL_MS) {
      localStorage.removeItem(questionCacheStorageKey(options));
      return null;
    }

    if (cached.questions.length < minCount) return null;
    return cached.questions;
  } catch (error) {
    return null;
  }
}

function writeCachedQuestions(options, questions) {
  try {
    localStorage.setItem(questionCacheStorageKey(options), JSON.stringify({
      createdAt: Date.now(),
      questions
    }));
  } catch (error) {
    // Caching is optional. Never break gameplay.
  }
}

function clearCachedQuestions(options) {
  try {
    localStorage.removeItem(questionCacheStorageKey(options));
  } catch (error) {
    // Ignore.
  }
}

function questionCountForOptions(options) {
  return clamp(Number(options.roundsRequested || 10), 1, 20) + (options.practiceEnabled ? 1 : 0);
}

function currentToneMode() {
  return state.game?.toneMode || $("toneMode")?.value || "lads";
}

function isPracticeRound() {
  return Boolean(state.game?.practiceEnabled && state.game.currentRound === 0);
}

function scoredRoundTotal() {
  const requested = Number(state.game?.roundsRequested) || 0;
  const fromQuestions = Math.max(0, (state.game?.questions?.length || 0) - (state.game?.practiceEnabled ? 1 : 0));
  // Always at least 1 so the UI can never render "Round 0 of 0".
  return Math.max(1, requested || fromQuestions || 1);
}

function scoredRoundNumber() {
  if (!state.game?.started) return 0;
  return Math.max(0, state.game.currentRound + 1 - (state.game.practiceEnabled ? 1 : 0));
}

function roundLabel() {
  if (!state.game?.started) return `Round 0 of ${scoredRoundTotal()}`;
  if (isPracticeRound()) return "Practice round";
  return `Round ${scoredRoundNumber()} of ${scoredRoundTotal()}`;
}

function isFinalScoredRound() {
  return Boolean(state.game?.started && state.game?.revealed && !isPracticeRound() && state.game.currentRound >= ((state.game.questions?.length || 1) - 1));
}

function pubQuizPointsForIndex(index) {
  return [10, 8, 6, 4, 2][index] || 0;
}

function shuffle(items) {
  const cloned = [...items];
  for (let i = cloned.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cloned[i], cloned[j]] = [cloned[j], cloned[i]];
  }
  return cloned;
}

function parseWikidataPoint(pointValue) {
  const cleaned = String(pointValue || "").replace("Point(", "").replace(")", "");
  const parts = cleaned.split(" ").map(Number);
  if (parts.length !== 2 || Number.isNaN(parts[0]) || Number.isNaN(parts[1])) return null;
  return { lng: parts[0], lat: parts[1] };
}

async function fetchRandomQuestionsFromWikidata(count = 10, options = {}) {
  const params = new URLSearchParams({
    count: String(clamp(Number(count || 10), 1, 25)),
    questionType: options.questionType || "city",
    cityDifficulty: options.cityDifficulty || "mixed",
    practiceEnabled: String(Boolean(options.practiceEnabled)),
    mapMode: options.mapMode || "hardcore",
    scoringMode: options.scoringMode || "distance"
  });

  const response = await fetch(`/api/questions?${params.toString()}`, {
    headers: { Accept: "application/json" }
  });

  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail?.message || detail?.error || "Question API failed");
  }

  const payload = await response.json();
  return payload.questions || [];
}

function shuffleCopy(items) {

  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

async function warmCityPool(count = 10, options = getSetupOptions()) {
  const requestedTarget = clamp(Number(count || 10), 1, 25);
  const warmTarget = clamp(Math.max(requestedTarget, QUESTION_WARM_POOL_SIZE), requestedTarget, 25);
  const key = optionsKey(options);

  const cached = readCachedQuestions(options, requestedTarget);
  if (cached) {
    state.prefetchedQuestions = cached;
    state.prefetchedCount = cached.length;
    state.prefetchKey = key;
    setWarmupStatus(`Questions ready - ${cached.length} cached`, "ready");
    return cached.slice(0, requestedTarget);
  }

  if (state.prefetchPromise && state.prefetchKey === key && state.prefetchedCount >= requestedTarget) return state.prefetchPromise;
  if (state.prefetchedQuestions && state.prefetchKey === key && state.prefetchedCount >= requestedTarget) {
    setWarmupStatus(`Questions ready - ${state.prefetchedCount} loaded`, "ready");
    return state.prefetchedQuestions.slice(0, requestedTarget);
  }

  setWarmupStatus("Warming up the question pack...");
  state.prefetchKey = key;
  state.prefetchPromise = fetchRandomQuestionsFromWikidata(warmTarget, options)
    .then((questions) => {
      state.prefetchedQuestions = questions;
      state.prefetchedCount = questions.length;
      state.prefetchPromise = null;
      writeCachedQuestions(options, questions);
      setWarmupStatus(`Questions ready - ${questions.length} loaded`, "ready");
      return questions;
    })
    .catch((error) => {
      state.prefetchPromise = null;
      setWarmupStatus("Question warm-up failed. You can still try again.");
      throw error;
    });

  return state.prefetchPromise;
}

function consumePrefetchedQuestions(count, options = getSetupOptions()) {
  const target = clamp(Number(count || 10), 1, 25);
  const key = optionsKey(options);

  if (state.prefetchedQuestions && state.prefetchKey === key && state.prefetchedCount >= target) {
    const picked = shuffleCopy(state.prefetchedQuestions).slice(0, target);
    state.prefetchedQuestions = null;
    state.prefetchedCount = 0;
    state.prefetchKey = null;
    clearCachedQuestions(options);
    return picked;
  }

  const cached = readCachedQuestions(options, target);
  if (cached) {
    const picked = shuffleCopy(cached).slice(0, target);
    clearCachedQuestions(options);
    return picked;
  }

  return null;
}


function setWarmupStatus(message, mode = "loading") {
  // Silent background warm-up. Keep this as a hook for debugging/analytics,
  // but do not show a front-end status banner.
  state.lastWarmupStatus = { message, mode, ts: Date.now() };
}

function hideWarmupStatus() {
  state.lastWarmupStatus = null;
}

function showLoading(title, text) {
  const overlay = $("loadingOverlay");
  if (!overlay) return;
  $("loadingTitle").textContent = title || "Loading";
  $("loadingText").textContent = text || "Please wait a moment.";
  overlay.classList.remove("hidden");
}

function hideLoading() {
  $("loadingOverlay")?.classList.add("hidden");
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function toast(message) {
  const el = $("toast");
  if (!el) return;
  // Skip back-to-back duplicates so a flurry of map taps doesn't queue
  // a stack of identical "Pin placed" toasts.
  if (state.lastToastMessage === message && Date.now() - (state.lastToastAt || 0) < 1500) return;
  state.lastToastMessage = message;
  state.lastToastAt = Date.now();
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(state.toastHideTimer);
  state.toastHideTimer = setTimeout(() => el.classList.remove("show"), 2100);
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = deg => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function pointsForDistance(distanceKm, hasGuess = true) {
  if (!hasGuess || !Number.isFinite(distanceKm)) return 0;

  const base = Math.round(1000 * Math.exp(-distanceKm / 1700));
  return Math.max(MIN_SUBMITTED_SCORE, base);
}

function longitudeNearestToReference(lng, referenceLng) {
  let adjusted = lng;
  while (adjusted - referenceLng > 180) adjusted -= 360;
  while (adjusted - referenceLng < -180) adjusted += 360;
  return adjusted;
}

function wrappedGuessForAnswer(guess, answer) {
  return {
    lat: guess.lat,
    lng: longitudeNearestToReference(guess.lng, answer.lng)
  };
}

// --- Country mode scoring helpers ---------------------------------------
// Geometry comes from /api/questions as GeoJSON Polygon or MultiPolygon
// in [lng, lat] order (per the spec). Helpers handle MultiPolygon and
// the antimeridian by normalising longitudes relative to the test point.

function isCountryQuestion(question) {
  return question?.type === "country" || state.game?.questionType === "country";
}

function ringContainsPoint(ring, lat, lng) {
  // Standard ray-casting; ring is [[lng, lat], ...].
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lng < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function polygonContainsPoint(polygon, lat, lng) {
  if (!polygon?.length) return false;
  if (!ringContainsPoint(polygon[0], lat, lng)) return false;
  for (let i = 1; i < polygon.length; i++) {
    if (ringContainsPoint(polygon[i], lat, lng)) return false; // hole
  }
  return true;
}

function geometryContainsPoint(geometry, lat, lng) {
  if (!geometry) return false;
  // Test the point against the original lng and the antimeridian-shifted lng,
  // so guesses near +180/-180 still register correctly.
  const candidates = [lng];
  if (lng < 0) candidates.push(lng + 360);
  else candidates.push(lng - 360);

  if (geometry.type === "Polygon") {
    return candidates.some((c) => polygonContainsPoint(geometry.coordinates, lat, c));
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.some((poly) =>
      candidates.some((c) => polygonContainsPoint(poly, lat, c))
    );
  }
  return false;
}

function nearestPointOnSegmentKm(plat, plng, alat, alng, blat, blng) {
  // Equirectangular projection at the mean latitude is plenty accurate
  // for country-scale border distances. Caller must already have shifted
  // segment longitudes into ±180° of plng.
  const meanLat = ((alat + blat) / 2) * Math.PI / 180;
  const cos = Math.cos(meanLat) || 1e-9;
  const ax = alng * cos, ay = alat;
  const bx = blng * cos, by = blat;
  const px = plng * cos, py = plat;
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const cy = ay + t * dy;
  const cx = ax + t * dx;
  const lat = cy;
  const lng = cx / cos;
  return haversineKm(plat, plng, lat, lng);
}

function shiftLngTo(target, ref) {
  let v = target;
  while (v - ref > 180) v -= 360;
  while (v - ref < -180) v += 360;
  return v;
}

function distanceFromPointToRingKm(ring, plat, plng) {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    const alng = shiftLngTo(a[0], plng);
    const blng = shiftLngTo(b[0], plng);
    const d = nearestPointOnSegmentKm(plat, plng, a[1], alng, b[1], blng);
    if (d < best) best = d;
  }
  return best;
}

function distanceToBorderKm(geometry, lat, lng) {
  if (!geometry) return Infinity;
  if (geometryContainsPoint(geometry, lat, lng)) return 0;
  let best = Infinity;
  if (geometry.type === "Polygon") {
    for (const ring of geometry.coordinates) {
      const d = distanceFromPointToRingKm(ring, lat, lng);
      if (d < best) best = d;
    }
  } else if (geometry.type === "MultiPolygon") {
    for (const poly of geometry.coordinates) {
      for (const ring of poly) {
        const d = distanceFromPointToRingKm(ring, lat, lng);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

function pointsForCountryDistance(distanceKm, inside, hasGuess = true) {
  if (!hasGuess) return 0;
  if (inside) return 1000;
  if (!Number.isFinite(distanceKm)) return 0;
  // Two-part curve so wrong-continent guesses still differentiate:
  // - exp curve dominates for near-border misses (1500km and below)
  // - linear tail keeps the long tail discriminating (11,000km != 15,000km)
  // No 50-point floor in country mode - that was a city-mode "you tried"
  // courtesy and was making every catastrophic miss read as identical.
  const expPart = 1000 * Math.exp(-distanceKm / 1200);
  const tailPart = Math.max(0, 60 * (1 - distanceKm / 20000));
  // Cap outside-the-border score below 1000 so being inside is always a
  // strict win, even from one metre over the border.
  return Math.max(0, Math.min(999, Math.round(expPart + tailPart)));
}

function scoreGuessForQuestion(guess, question) {
  if (!guess || !question) {
    return { hasGuess: false, distance: Infinity, points: 0, inside: false };
  }
  if (question.type === "country" && question.geometry) {
    const inside = geometryContainsPoint(question.geometry, guess.lat, guess.lng);
    const distance = inside ? 0 : distanceToBorderKm(question.geometry, guess.lat, guess.lng);
    const points = pointsForCountryDistance(distance, inside, true);
    return { hasGuess: true, distance, points, inside };
  }
  const distance = haversineKm(guess.lat, guess.lng, question.lat, question.lng);
  const points = pointsForDistance(distance, true);
  return { hasGuess: true, distance, points, inside: false };
}

function distanceTextForRow(row, question) {
  if (!row?.hasGuess) return "No guess submitted";
  if (question?.type === "country") {
    if (row.inside) return "Inside the country";
    return `${Math.round(row.distance).toLocaleString()} km from the border`;
  }
  return `${Math.round(row.distance).toLocaleString()} km away`;
}

function showGameScreen() {
  document.body.classList.add("in-game");
  $("homeScreen").classList.add("hidden");
  $("gameScreen").classList.remove("hidden");
  $("leaveBtn").classList.remove("hidden");

  // Important on mobile: users often start from a scrolled landing page.
  // Jump to the game top so the map/question panel is visible immediately.
  requestAnimationFrame(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  });

  setTimeout(() => {
    initMap();
    if (state.map) state.map.invalidateSize();
  }, 50);
}

function setBaseMapLayer(mode = "hardcore") {
  if (!state.map) return;
  const safeMode = mode || "hardcore";
  if (state.baseLayer && state.baseMapMode === safeMode) return;

  if (state.baseLayer) {
    state.map.removeLayer(state.baseLayer);
    state.baseLayer = null;
  }

  const layers = {
    hardcore: {
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Shaded_Relief/MapServer/tile/{z}/{y}/{x}",
      options: { maxZoom: 8, className: "clean-map-tiles", attribution: "Tiles &copy; Esri" }
    },
    outlines: {
      url: "https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png",
      options: { subdomains: "abcd", maxZoom: 8, attribution: "&copy; OpenStreetMap contributors &copy; CARTO" }
    },
    labels: {
      url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      options: { maxZoom: 8, attribution: "&copy; OpenStreetMap contributors" }
    }
  };

  const config = layers[safeMode] || layers.hardcore;
  state.baseLayer = L.tileLayer(config.url, config.options).addTo(state.map);
  state.baseMapMode = safeMode;
}

function initMap() {
  if (state.map) {
    state.map.invalidateSize();
    return;
  }

  const isMobileViewport = window.matchMedia("(max-width: 860px)").matches;
  state.map = L.map("map", {
    worldCopyJump: false,
    minZoom: 2,
    maxZoom: 8,
    zoomControl: false,
    bounceAtZoomLimits: false,
    inertia: !isMobileViewport,
    tap: false
  }).setView([20, 0], 2);

  L.control.zoom({ position: "bottomleft" }).addTo(state.map);

  if (isMobileViewport) {
    state.map.scrollWheelZoom.disable();
    state.map.doubleClickZoom.disable();
    state.map.boxZoom.disable();
    state.map.keyboard.disable();
  }

  setBaseMapLayer(state.game?.mapMode || getSetupOptions().mapMode);

  state.map.on("click", async (event) => {
    if (!state.game) return;
    const solo = isSoloGame();
    if (!state.game.started || state.game.revealed) {
      toast(solo ? "Start the round before placing a pin" : "Wait for the host to start the round");
      return;
    }
    // Solo can keep tapping to reposition until the timer expires or the
    // player hits Score round. Multiplayer respects acceptingGuesses, which
    // gets flipped off when all players are in or time is up.
    if (!solo && !state.game.acceptingGuesses) {
      toast("Round is closed - waiting for the answer reveal");
      return;
    }
    if (isTimerExpired()) {
      toast("Time's up. No points for late pins.");
      return;
    }

    state.selectedGuess = {
      lat: Number(event.latlng.lat.toFixed(6)),
      lng: Number(event.latlng.lng.toFixed(6))
    };

    if (state.guessMarker) state.guessMarker.remove();
    state.guessMarker = L.marker([state.selectedGuess.lat, state.selectedGuess.lng], { icon: markerIcons.guess }).addTo(state.map);
    submitGuess();
  });
}

async function submitGuess() {
  if (!state.selectedGuess || !state.gameCode || !state.playerId || !state.game || isTimerExpired()) return;
  if (state.game.roundPlayerIds && !state.game.roundPlayerIds[state.playerId]) {
    toast("You joined mid-round. You're in from the next one.");
    return;
  }

  const round = state.game.currentRound;
  await set(ref(db, `games/${state.gameCode}/guesses/${round}/${state.playerId}`), {
    ...state.selectedGuess,
    playerName: state.playerName,
    submittedAt: serverTimestamp()
  });
  trackEvent("round_guess_submitted", { code: state.gameCode, round, time_to_guess: typeof timeToGuess !== "undefined" ? timeToGuess : null, timer_setting: state.game?.roundDurationSeconds });
  toast("Pin placed - tap elsewhere to move it");
}

// Play today's daily challenge. Solo only. Settings (rounds/timer/map)
// are locked so every player on the same UTC day plays an identical
// challenge - lets us compare scores fairly. Tone respects the user's
// saved preference (it only affects banter copy, not scoring).
async function playDailyChallenge() {
  if (!isFirebaseConfigured) {
    toast("Paste Firebase config first");
    return;
  }
  if (state.dailyLoading) return;
  state.dailyLoading = true;

  const btn = $("playDailyBtn");
  if (btn) {
    btn.disabled = true;
    btn.dataset.prevText = btn.textContent;
    btn.textContent = "Loading today's challenge...";
  }
  showLoading("Loading today's challenge", "Today's pack is the same for every player.");

  let payload;
  try {
    const response = await fetch("/api/questions?daily=1", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`Daily API ${response.status}`);
    payload = await response.json();
  } catch (error) {
    toast("Couldn't load today's challenge. Try again in a moment.");
    if (btn) { btn.disabled = false; btn.textContent = btn.dataset.prevText || "Play today's challenge"; }
    state.dailyLoading = false;
    hideLoading();
    return;
  }

  const questions = Array.isArray(payload.questions) ? payload.questions : [];
  const dailyDate = String(payload.dailyDate || todayUtcDateString());
  if (!questions.length) {
    toast("No daily questions returned. Try again later.");
    if (btn) { btn.disabled = false; btn.textContent = btn.dataset.prevText || "Play today's challenge"; }
    state.dailyLoading = false;
    hideLoading();
    return;
  }

  const userTone = $("toneMode")?.value || state.game?.toneMode || "lads";
  const rawHostName = $("hostName")?.value?.trim();
  const hostName = !rawHostName || rawHostName.toLowerCase() === "quiz host" ? "You" : rawHostName;

  const code = roomCode();
  const playerId = `host_${uid()}`;
  const game = {
    code,
    createdAt: Date.now(),
    hostId: playerId,
    hostName,
    questions,
    // Locked daily settings for fair comparison.
    roundsRequested: questions.length,
    practiceEnabled: false,
    questionType: "daily",
    cityDifficulty: "mixed",
    mapMode: "hardcore",
    toneMode: userTone,
    scoringMode: "distance",
    singlePlayer: true,
    dailyChallenge: true,
    dailyDate,
    currentRound: 0,
    acceptingGuesses: false,
    revealed: false,
    started: false,
    roundDurationSeconds: 30,
    roundStartedAt: null,
    roundEndsAt: null,
    roundClosedAt: null,
    roundClosedReason: null,
    roundPlayerIds: null
  };

  state.lastCreateOptions = {
    isSinglePlayer: true,
    dailyChallenge: true,
    dailyDate,
    questionType: "daily",
    roundsRequested: questions.length,
    createdAt: Date.now()
  };

  try {
    await set(ref(db, `games/${code}`), game);
    await set(ref(db, `games/${code}/players/${playerId}`), {
      name: hostName,
      avatar: randomAvatar(),
      total: 0,
      isHost: true,
      joinedAt: Date.now(),
      online: true
    });
    onDisconnect(ref(db, `games/${code}/players/${playerId}/online`)).set(false);
  } catch (error) {
    toast("Couldn't start today's challenge. Try again.");
    if (btn) { btn.disabled = false; btn.textContent = btn.dataset.prevText || "Play today's challenge"; }
    state.dailyLoading = false;
    hideLoading();
    return;
  }

  trackEvent?.("daily_challenge_started", { dailyDate, questionCount: questions.length });

  hideLoading();
  if (btn) { btn.disabled = false; btn.textContent = btn.dataset.prevText || "Play today's challenge"; }
  state.dailyLoading = false;
  enterGame(code, playerId, hostName, true);
}

async function createGame(isSinglePlayer = false) {
  if (!isFirebaseConfigured) {
    toast("Paste Firebase config first");
    return;
  }

  const rawHostName = $("hostName").value.trim();
  const hostName = isSinglePlayer
    ? (!rawHostName || rawHostName.toLowerCase() === "quiz host" ? "You" : rawHostName)
    : (rawHostName || "Quiz host");
  // Read setup straight from the DOM so Play solo always reflects the
  // current dropdowns/inputs, even if a previous game stashed defaults.
  const options = getSetupOptions();
  // Defensive clamp: never start a 0-round game even if upstream code is
  // tampered with.
  options.roundsRequested = clamp(Number(options.roundsRequested) || 10, 1, 20);
  options.roundDurationSeconds = clamp(Number(options.roundDurationSeconds) || ROUND_DURATION_SECONDS, 10, 60);
  const questionCount = questionCountForOptions(options);
  state.lastCreateOptions = { ...options, isSinglePlayer: Boolean(isSinglePlayer), createdAt: Date.now() };

  $("createGameBtn").disabled = true;
  $("playSoloBtn").disabled = true;
  $("createGameBtn").textContent = "Fetching random questions...";
  showLoading("Preparing your game", "Finding a fresh set of cities. First load can take a few seconds, but future games should be faster.");

  let questions = consumePrefetchedQuestions(questionCount, options);

  try {
    if (!questions && state.prefetchPromise && state.prefetchKey === optionsKey(options)) {
      questions = await state.prefetchPromise;
    }
    if (!questions) {
      questions = await fetchRandomQuestionsFromWikidata(questionCount, options);
    }
  } catch (error) {
    toast("Question lookup failed. Try again in a moment.");
    $("createGameBtn").disabled = false;
    $("playSoloBtn").disabled = false;
    $("createGameBtn").textContent = "Create a room";
    hideLoading();
    return;
  }

  $("createGameBtn").disabled = false;
  $("playSoloBtn").disabled = false;
  $("createGameBtn").textContent = "Create a room";
  hideLoading();

  setTimeout(() => {
    warmCityPool(questionCountForOptions(getSetupOptions()), getSetupOptions()).catch(() => {});
  }, 250);

  const code = roomCode();
  const playerId = `host_${uid()}`;

  const game = {
    code,
    createdAt: Date.now(),
    hostId: playerId,
    hostName,
    questions,
    roundsRequested: options.roundsRequested,
    practiceEnabled: options.practiceEnabled,
    questionType: options.questionType,
    cityDifficulty: options.cityDifficulty,
    mapMode: options.mapMode,
    toneMode: options.toneMode,
    scoringMode: options.scoringMode,
    singlePlayer: Boolean(isSinglePlayer),
    currentRound: 0,
    acceptingGuesses: false,
    revealed: false,
    started: false,
    roundDurationSeconds: options.roundDurationSeconds,
    roundStartedAt: null,
    roundEndsAt: null,
    roundClosedAt: null,
    roundClosedReason: null,
    roundPlayerIds: null
  };

  await set(ref(db, `games/${code}`), game);
  await set(ref(db, `games/${code}/players/${playerId}`), {
    name: hostName,
    avatar: randomAvatar(),
    total: 0,
    isHost: true,
    joinedAt: Date.now(),
    online: true
  });
  onDisconnect(ref(db, `games/${code}/players/${playerId}/online`)).set(false);
  enterGame(code, playerId, hostName, true);
}

async function joinGame() {
  if (!isFirebaseConfigured) {
    toast("Paste Firebase config first");
    return;
  }

  const code = $("joinCode").value.trim().toUpperCase();
  const name = $("playerName").value.trim();
  if (!code || !name) {
    toast("Add your name and room code");
    return;
  }

  const snap = await get(ref(db, `games/${code}`));
  if (!snap.exists()) {
    toast("Room not found");
    return;
  }

  const game = snap.val();
  const normalizedName = normalisePlayerName ? normalisePlayerName(name) : String(name).trim().toLowerCase();
  const forceNewPlayer = sessionStorage.getItem("pinThePlanetForceNewPlayer") === "1" || new URLSearchParams(window.location.search).get("newPlayer") === "1";

  // Reuse this browser's saved session only when it looks like the same person.
  // This avoids the "second tab becomes the host" problem when testing with one browser.
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem("worldPinQuizSession") || "null");
  } catch (error) {
    saved = null;
  }

  if (!forceNewPlayer && saved?.code === code && saved?.playerId && game.players?.[saved.playerId]) {
    const savedPlayer = game.players[saved.playerId];
    const savedName = normalisePlayerName ? normalisePlayerName(savedPlayer.name || saved.playerName) : String(savedPlayer.name || saved.playerName || "").trim().toLowerCase();

    if (savedName === normalizedName) {
      await update(ref(db, `games/${code}/players/${saved.playerId}`), {
        name,
        online: true,
        rejoinedAt: Date.now()
      });
      onDisconnect(ref(db, `games/${code}/players/${saved.playerId}/online`)).set(false);
      toast("Rejoined existing player");
      enterGame(code, saved.playerId, name, Boolean(saved.isHost));
      return;
    }
  }

  // If another non-host record with the same name exists, reuse it.
  const matchingEntries = Object.entries(game.players || {})
    .filter(([id, player]) => !player.isHost && (normalisePlayerName ? normalisePlayerName(player.name) : String(player.name || "").trim().toLowerCase()) === normalizedName)
    .sort((a, b) => {
      const pa = a[1];
      const pb = b[1];
      if (pa.online !== false && pb.online === false) return -1;
      if (pa.online === false && pb.online !== false) return 1;
      return (pb.rejoinedAt || pb.joinedAt || 0) - (pa.rejoinedAt || pa.joinedAt || 0);
    });

  if (!forceNewPlayer && matchingEntries.length) {
    const [existingPlayerId] = matchingEntries[0];

    await update(ref(db, `games/${code}/players/${existingPlayerId}`), {
      name,
      online: true,
      rejoinedAt: Date.now()
    });

    await Promise.all(matchingEntries.slice(1).map(([duplicateId]) => {
      return remove(ref(db, `games/${code}/players/${duplicateId}`)).catch(() => {});
    }));

    onDisconnect(ref(db, `games/${code}/players/${existingPlayerId}/online`)).set(false);
    sessionStorage.removeItem("pinThePlanetForceNewPlayer");
    toast("Rejoined existing player");
    enterGame(code, existingPlayerId, name, false);
    return;
  }

  const playerId = `player_${uid()}`;
  await set(ref(db, `games/${code}/players/${playerId}`), {
    name,
    avatar: pickUniqueAvatar(game),
    total: 0,
    isHost: false,
    joinedAt: Date.now(),
    online: true
  });
  onDisconnect(ref(db, `games/${code}/players/${playerId}/online`)).set(false);
  sessionStorage.removeItem("pinThePlanetForceNewPlayer");
  trackEvent?.("room_joined", { code });
  enterGame(code, playerId, name, false);
}

function enterGame(code, playerId, playerName, isHost) {
  state.gameCode = code;
  state.playerId = playerId;
  state.playerName = playerName;
  state.isHost = isHost;
  localStorage.setItem("worldPinQuizSession", JSON.stringify({ code, playerId, playerName, isHost }));
  $("roomCodeDisplay").textContent = code;
  $("hostControls").classList.toggle("hidden", !isHost);
  showGameScreen();
  subscribeToGame();
  attachPresenceWatcher();
}

// Keep this player's online flag truthful across iOS/Safari tab
// suspensions and brief network drops. The previous code relied on the
// initial onDisconnect, which fires when iOS pauses the WebSocket (e.g.
// when the host switches to Messages to share the join link). Once
// fired, nothing was re-setting online to true on return, so the host
// looked permanently offline to other players.
function attachPresenceWatcher() {
  if (!db || !state.gameCode || !state.playerId) return;
  if (state.presenceAttached) return;
  state.presenceAttached = true;

  const onlineRef = ref(db, `games/${state.gameCode}/players/${state.playerId}/online`);
  const connectedRef = ref(db, ".info/connected");

  // Whenever the Firebase socket reports we're connected, make sure our
  // own player record is online and the next disconnect will mark us
  // offline again. onDisconnect must be re-armed after every reconnect.
  onValue(connectedRef, (snap) => {
    if (snap.val() !== true) return;
    if (!state.gameCode || !state.playerId) return;
    onDisconnect(onlineRef).set(false);
    set(onlineRef, true).catch(() => {});
  });

  // iOS Safari often delivers visibilitychange before the WebSocket
  // recovers; nudging online here makes the UI catch up quickly when
  // the host returns from sharing the join link.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (!state.gameCode || !state.playerId) return;
    set(ref(db, `games/${state.gameCode}/players/${state.playerId}/online`), true).catch(() => {});
  });

  // Same nudge when the tab is restored from the bfcache.
  window.addEventListener("pageshow", () => {
    if (!state.gameCode || !state.playerId) return;
    set(ref(db, `games/${state.gameCode}/players/${state.playerId}/online`), true).catch(() => {});
  });
}

function subscribeToGame() {
  const gameRef = ref(db, `games/${state.gameCode}`);
  onValue(gameRef, (snap) => {
    if (!snap.exists()) {
      toast("Room was removed");
      leaveGame(false);
      return;
    }
    state.game = snap.val();
    renderGame();
  });
}

function currentQuestion() {
  if (!state.game || !state.game.questions) return null;
  return state.game.questions[state.game.currentRound] || null;
}

function currentQuestionName() {
  return currentQuestion()?.name || "Finished";
}

function visibleRoundInfo() {
  return roundLabel();
}

function guessesForCurrentRound() {
  const round = state.game?.currentRound || 0;
  return state.game?.guesses?.[round] || {};
}

function normalisePlayerName(name = "") {
  return String(name).trim().toLowerCase().replace(/\s+/g, " ");
}

function dedupePlayersForDisplay(players) {
  const seen = new Map();
  const output = [];

  players.forEach((player) => {
    if (player.isHost) {
      output.push(player);
      return;
    }

    const key = normalisePlayerName(player.name);
    if (!key) {
      output.push(player);
      return;
    }

    const existingIndex = seen.get(key);
    if (existingIndex === undefined) {
      seen.set(key, output.length);
      output.push(player);
      return;
    }

    const existing = output[existingIndex];
    const shouldReplace =
      (existing.online === false && player.online !== false) ||
      ((player.rejoinedAt || player.joinedAt || 0) > (existing.rejoinedAt || existing.joinedAt || 0));

    if (shouldReplace) output[existingIndex] = player;
  });

  return output;
}

function onlinePlayersArray() {
  return dedupePlayersForDisplay(playersArray()).filter(player => player.online !== false);
}

function currentHostPlayer() {
  return playersArray().find(player => player.isHost);
}

function playersArray() {
  return Object.entries(state.game?.players || {}).map(([id, player]) => ({ id, ...player }));
}

function secondsLeft() {
  if (!state.game?.roundEndsAt || !state.game.acceptingGuesses || state.game.revealed) return null;
  return Math.max(0, Math.ceil((state.game.roundEndsAt - Date.now()) / 1000));
}

function isTimerExpired() {
  return Boolean(state.game?.roundEndsAt && Date.now() > state.game.roundEndsAt);
}

function hasRoundTimerEnded() {
  return Boolean(state.game?.roundEndsAt && Date.now() >= state.game.roundEndsAt);
}

function eligiblePlayersArray() {
  const players = playersArray();
  const roundIds = state.game?.roundPlayerIds;
  if (!state.game?.started || !roundIds) return players;
  return players.filter(player => Boolean(roundIds[player.id]));
}

function allPlayersHaveGuessed() {
  const players = eligiblePlayersArray();
  const guesses = guessesForCurrentRound();
  return players.length > 0 && players.every(player => Boolean(guesses[player.id]));
}

function currentRoundKey() {
  return `${state.game?.currentRound ?? 0}-${state.game?.roundStartedAt || "not-started"}`;
}

async function maybeAutoCloseRound() {
  if (!state.isHost || !state.game?.started || !state.game.acceptingGuesses || state.game.revealed) return;

  const left = secondsLeft();
  // Don't auto-close on all-guessed any more, in either mode. Players
  // expect to be able to keep repositioning their pin until either the
  // timer runs out or the host clicks Reveal. The reveal button is
  // already enabled by canReveal as soon as everyone has guessed, so
  // the host always has the option to end the round early.
  const shouldCloseForTime = left === 0 || hasRoundTimerEnded();

  if (!shouldCloseForTime) return;

  const key = currentRoundKey();
  if (state.autoClosingRoundKey === key) return;
  state.autoClosingRoundKey = key;

  await update(ref(db, `games/${state.gameCode}`), {
    acceptingGuesses: false,
    roundClosedAt: Date.now(),
    roundClosedReason: "time-up"
  });
}

function isSoloGame() {
  return Boolean(state.game?.singlePlayer);
}

function roundRows() {
  const players = eligiblePlayersArray();
  const guesses = guessesForCurrentRound();
  const question = currentQuestion();
  return players
    .map(player => {
      const guess = guesses[player.id];
      if (!guess || !question) return { player, hasGuess: false, distance: Infinity, points: 0, inside: false, guess: null };
      const score = scoreGuessForQuestion(guess, question);
      return { player, ...score, guess };
    })
    .sort((a, b) => {
      const scoreDelta = (b.points || 0) - (a.points || 0);
      if (scoreDelta !== 0) return scoreDelta;
      return (a.distance || Infinity) - (b.distance || Infinity);
    });
}

function roundRowsByDistance(rows = roundRows()) {
  return [...rows]
    .filter(row => row.hasGuess && Number.isFinite(row.distance))
    .sort((a, b) => a.distance - b.distance);
}

function bestAndWorstRows(rows = roundRows()) {
  const byDistance = roundRowsByDistance(rows);
  if (!byDistance.length) return { best: null, worst: null, byDistance: [] };
  return {
    best: byDistance[0],
    worst: byDistance[byDistance.length - 1],
    byDistance
  };
}

function renderGame() {
  if (!state.game) return;

  const isSolo = isSoloGame();
  $("roomCodeDisplay").textContent = isSolo ? "SOLO" : state.gameCode;
  $("copyLinkBtn").classList.toggle("hidden", isSolo);
  document.body.classList.toggle("single-player-game", isSolo);
  document.body.classList.toggle("round-revealed-state", Boolean(state.game.revealed));
  document.body.classList.toggle("round-live-state", Boolean(state.game.started && !state.game.revealed));
  if ($("roomCodeLabel")) $("roomCodeLabel").textContent = isSolo ? "Mode" : "Room code";
  if ($("hostControlsTitle")) $("hostControlsTitle").textContent = isSolo ? "Solo controls" : "Host controls";
  const question = currentQuestion();
  const displayLabel = visibleRoundInfo();
  const left = secondsLeft();
  const timeUp = state.game.started && !state.game.revealed && (left === 0 || state.game.roundClosedReason === "time-up");
  const allIn = allPlayersHaveGuessed() && state.game.started && !state.game.revealed;
  const roundClosedByAll = state.game.roundClosedReason === "all-guessed";
  const roundClosed = state.game.started && !state.game.revealed && !state.game.acceptingGuesses;
  const isFinalRound = isFinalScoredRound();
  const isFinalComplete = Boolean(state.game.started && state.game.revealed && isFinalRound);

  document.body.classList.toggle("final-round-state", isFinalComplete);

  $("roundInfo").textContent = displayLabel;

  if (left === null || !state.game.started || state.game.revealed || roundClosed) {
    $("countdownDisplay").classList.add("hidden");
  } else {
    $("countdownDisplay").classList.remove("hidden");
    $("countdownDisplay").classList.toggle("hot", left <= 5);
    $("countdownDisplay").textContent = left;
  }

  $("allGuessesBanner").classList.add("hidden");
  $("allGuessesBanner").classList.remove("time-up");

  if (!state.game.started) {
    $("roundState").textContent = isSolo ? "Ready when you are" : "Waiting for host to start";
    $("targetName").textContent = "Get ready";
    $("playerHint").textContent = isSolo ? "Start your solo run when you're ready." : (state.isHost ? "Start the first round when everyone has joined." : "The quiz will begin shortly.");
  } else if (state.game.revealed) {
    $("roundState").textContent = `${isFinalRound ? "Final answer revealed" : isPracticeRound() ? "Practice answer revealed" : `Answer revealed - ${displayLabel}`}`;
    $("targetName").textContent = locationDisplayName(question) || "Finished";
    $("playerHint").textContent = isFinalRound
      ? (isSolo ? "Solo run finished. See if you set a new best." : "Game finished. Prepare the excuses.")
      : isSolo
        ? "Check your score, then start the next round."
        : state.isHost
          ? "Check the results, then start the next round."
          : "Check the results, then wait for the next round.";
  } else if (timeUp) {
    $("roundState").textContent = `${displayLabel} - time's up`;
    $("targetName").textContent = locationDisplayName(question) || "Finished";
    $("playerHint").textContent = isSolo ? "Time is up. Score the round to see how close you were." : (state.isHost ? "Time is up. Reveal the answer and enjoy the carnage." : "Time is up. Waiting for the answer reveal.");
    $("allGuessesBanner").textContent = isSolo ? "⏰ Time's up - score your round." : (state.isHost ? "⏰ Time's up - reveal time." : "⏰ Time's up - waiting for host.");
    $("allGuessesBanner").classList.remove("hidden");
    $("allGuessesBanner").classList.add("time-up");
  } else {
    // Per-question type, not per-game type, so a daily challenge with a
    // mixed pack adapts each round to whatever's actually on screen.
    const isCountryRound = (question?.type || state.game.questionType) === "country";
    $("roundState").textContent = `${displayLabel} - ${isCountryRound ? "click inside the country" : "place your pin"}`;
    $("targetName").textContent = locationDisplayName(question) || "Finished";
    const countryHint = isCountryRound ? " Inside the country = full points." : "";
    $("playerHint").textContent = isSolo
      ? `Click the map to place or change your pin before time runs out.${countryHint}`
      : (state.isHost
        ? `Click the map to submit your own guess. The round closes automatically once everyone has guessed.${countryHint}`
        : `Click anywhere on the map to submit or change your guess.${countryHint}`);
    // In solo mode the player can keep repositioning, so the "everyone is
    // in" banner would be misleading. Skip it entirely for solo.
    if (!isSolo && (allIn || roundClosedByAll)) {
      $("allGuessesBanner").textContent = state.isHost ? "✅ All in - reveal whenever (pins still movable)." : "✅ All in - host can reveal. You can still move your pin.";
      $("allGuessesBanner").classList.remove("hidden");
    }
  }

  setBaseMapLayer(state.game.mapMode || "hardcore");
  renderPlayers();
  renderRoundStatus();
  renderLeaderboard();
  renderResults();
  renderHostButtons();
  renderMobileHostBar();
  renderMapMarkers();
  renderPersonalResult();
  renderRoundSpotlight();
  renderFinalMapOverlay();
  maybeAutoCloseRound();
}

function renderHostButtons() {
  if (!state.isHost || !state.game) return;

  const hasStarted = Boolean(state.game.started);
  const isLastRound = state.game.currentRound >= (state.game.questions?.length || 1) - 1;
  const isRevealed = Boolean(state.game.revealed);
  const canReveal = hasStarted && !isRevealed && (!state.game.acceptingGuesses || allPlayersHaveGuessed() || secondsLeft() === 0 || hasRoundTimerEnded());
  const isFinalComplete = hasStarted && isRevealed && isLastRound && !isPracticeRound();

  const startBtn = $("startRoundBtn");
  const revealBtn = $("revealBtn");
  const nextBtn = $("nextRoundBtn");
  const restartBtn = $("restartRoundBtn");
  const resetBtn = $("resetGameBtn");
  const newGameBtn = $("newGameSamePlayersBtn");
  const copyResultsBtn = $("copyResultsBtn");
  const completeBox = $("gameCompleteHost");

  setVisible(startBtn, !hasStarted);
  setVisible(revealBtn, hasStarted && !isRevealed);
  setVisible(nextBtn, hasStarted && isRevealed && !isLastRound);
  setVisible(restartBtn, hasStarted && !isRevealed);
  setVisible(resetBtn, true);
  setVisible(newGameBtn, isFinalComplete);
  setVisible(copyResultsBtn, isFinalComplete);
  setVisible(completeBox, isFinalComplete);

  startBtn.disabled = hasStarted;
  revealBtn.disabled = !canReveal;
  nextBtn.disabled = !hasStarted || !isRevealed || isLastRound;

  const isSolo = isSoloGame();
  startBtn.textContent = isSolo ? "Start solo run" : "Start game";
  revealBtn.textContent = canReveal ? (isSolo ? "Score round" : "Reveal answer") : (isSolo ? "Place a pin or wait" : "Waiting for guesses");
  nextBtn.textContent = "Next round";
  if (restartBtn) restartBtn.textContent = "Restart round";
  if (resetBtn) resetBtn.textContent = isSolo ? "Reset solo run" : "Reset room";
  if (newGameBtn) newGameBtn.textContent = isSolo ? "Play solo again" : "Play again with same group";
  const completeText = $("gameCompleteHost");
  if (completeText) {
    const strong = completeText.querySelector("strong");
    const p = completeText.querySelector("p");
    if (strong) strong.textContent = isSolo ? "🎯 Solo run complete" : "🏁 Game complete";
    if (p) p.textContent = isSolo ? "Final score is in. Ready for another go?" : "Final leaderboard is ready. Time for excuses.";
  }
}

function renderMobileHostBar() {
  const bar = $("mobileHostBar");
  if (!bar) return;

  const isMobile = window.matchMedia("(max-width: 860px)").matches;
  if (!state.isHost || !state.game || !isMobile) {
    bar.classList.add("hidden");
    document.body.classList.remove("has-mobile-host-bar");
    return;
  }

  const hasStarted = Boolean(state.game.started);
  const isRevealed = Boolean(state.game.revealed);
  const isLastRound = state.game.currentRound >= ((state.game.questions?.length || 1) - 1);
  const isFinalComplete = hasStarted && isRevealed && isLastRound && !isPracticeRound();
  const canReveal = hasStarted && !isRevealed && (!state.game.acceptingGuesses || allPlayersHaveGuessed() || secondsLeft() === 0 || hasRoundTimerEnded());
  const left = secondsLeft();

  bar.classList.remove("hidden");
  document.body.classList.add("has-mobile-host-bar");

  $("mobileHostRound").textContent = state.game.singlePlayer ? `Solo · ${visibleRoundInfo()}` : visibleRoundInfo();
  $("mobileHostStatus").textContent = isFinalComplete
    ? "Game complete"
    : !hasStarted
      ? "Ready"
      : isRevealed
        ? "Revealed"
        : left === 0
          ? "Time up"
          : left !== null
            ? `${left}s left`
            : "Live";

  const startBtn = $("mobileStartBtn");
  const revealBtn = $("mobileRevealBtn");
  const nextBtn = $("mobileNextBtn");
  const newGameBtn = $("mobileNewGameBtn");
  const copyResultsBtn = $("mobileCopyResultsBtn");
  const copyLinkBtn = $("mobileCopyBtn");

  setVisible(startBtn, !hasStarted);
  setVisible(revealBtn, hasStarted && !isRevealed);
  setVisible(nextBtn, hasStarted && isRevealed && !isLastRound);
  setVisible(newGameBtn, isFinalComplete);
  setVisible(copyResultsBtn, isFinalComplete);
  setVisible(copyLinkBtn, !isFinalComplete && !state.game.singlePlayer);

  startBtn.disabled = hasStarted;
  revealBtn.disabled = !canReveal;
  nextBtn.disabled = !hasStarted || !isRevealed || isLastRound;

  revealBtn.textContent = canReveal ? "Reveal answers" : "Waiting";
  nextBtn.textContent = "Next round";
}

function renderPlayers() {
  const allPlayers = playersArray();
  const players = dedupePlayersForDisplay(allPlayers).sort((a, b) => (b.total || 0) - (a.total || 0));
  const section = $("playersSection");

  if (state.game?.started) {
    section.classList.add("hidden");
    return;
  }

  section.classList.remove("hidden");
  const onlineCount = players.filter(player => player.online !== false).length;
  $("playerCount").textContent = `${onlineCount} online`;
  const html = players.map(player => `
    <div class="player ${player.online === false ? "offline" : ""}">
      <div>
        <strong>${playerLabel(player)} ${player.isHost ? "<span class='tiny muted'>(host)</span>" : ""}</strong>
        <span class="small muted">${player.online !== false ? "Online" : "Offline - ignored next round"}</span>
      </div>
      <div class="score">${player.total || 0}</div>
    </div>
  `).join("");
  setHtmlIfChanged($("playersList"), html, "playersList");
}

function renderRoundStatus() {
  const panel = $("roundStatusPanel");
  if (!state.game?.started) {
    panel.classList.add("hidden");
    return;
  }

  const hostPlayer = currentHostPlayer?.();
  if (!isSoloGame() && !state.isHost && hostPlayer && hostPlayer.online === false) {
    panel.classList.remove("hidden");
    $("roundStatusPill").textContent = "Host offline";
    $("roundStatusMain").textContent = "Waiting for host";
    $("roundStatusSub").textContent = "The host has disconnected. They need to rejoin, or start a new room.";
    $("guessProgressBar").style.width = "0%";
    return;
  }

  const players = eligiblePlayersArray();
  const guesses = guessesForCurrentRound();
  const submitted = Object.keys(guesses).filter(id => players.some(player => player.id === id)).length;
  const total = players.length || 0;
  const left = secondsLeft();
  const isClosed = !state.game.acceptingGuesses && !state.game.revealed;
  const isRevealed = Boolean(state.game.revealed);
  const progress = total ? Math.round((submitted / total) * 100) : 0;

  panel.classList.remove("hidden");
  $("guessProgressBar").style.width = `${progress}%`;

  if (isRevealed) {
    $("roundStatusPill").textContent = "Revealed";
    if (isSoloGame()) {
      $("roundStatusMain").textContent = "Round scored";
      $("roundStatusSub").textContent = "Your score has been added. Check your result below.";
    } else {
      $("roundStatusMain").textContent = `Round complete - ${submitted}/${total} guessed`;
      $("roundStatusSub").textContent = "Scores are in. See the leaderboard and round banter below.";
    }
    return;
  }

  if (isClosed) {
    $("roundStatusPill").textContent = "Closed";
    if (isSoloGame()) {
      $("roundStatusMain").textContent = "Time's up";
      $("roundStatusSub").textContent = submitted ? "Score the round to see how you did." : "No pin placed. Score the round for a 0.";
    } else {
      $("roundStatusMain").textContent = `${submitted}/${total} guessed`;
      $("roundStatusSub").textContent = state.isHost ? "The round is closed. Reveal the answer when ready." : "The round is closed. Waiting for the answer reveal.";
    }
    return;
  }

  $("roundStatusPill").textContent = left === null ? "Live" : `${left}s left`;
  if (isSoloGame()) {
    $("roundStatusMain").textContent = submitted ? "Pin placed" : "Place your guess";
    $("roundStatusSub").textContent = submitted ? "Tap elsewhere to move it before scoring." : "Drop a pin before the timer ends.";
  } else {
    $("roundStatusMain").textContent = `${submitted}/${total} guessed`;
    $("roundStatusSub").textContent = submitted === total
      ? (state.isHost ? "Everyone is in. Reveal when ready (pins still movable)." : "Everyone is in. Host can reveal anytime. You can still move your pin.")
      : "Waiting for the remaining guesses.";
  }
}

function renderResults() {
  const section = $("roundResultsSection");
  if (!state.game?.started) {
    section.classList.add("hidden");
    return;
  }

  const isSolo = isSoloGame();
  const players = eligiblePlayersArray();
  const guesses = guessesForCurrentRound();
  const submitted = Object.keys(guesses).filter(id => players.some(player => player.id === id)).length;
  $("submittedCount").textContent = isSolo ? `${Math.min(submitted, 1) ? "Guess in" : "Waiting"}` : `${submitted}/${players.length} guesses`;

  const rows = roundRows();
  const resultsList = $("resultsList");

  if (isSolo && !state.game.revealed) {
    section.classList.add("hidden");
    resultsList.innerHTML = "";
    return;
  }

  section.classList.remove("hidden");

  if (!state.game.revealed) {
    $("roundResultsTitle").textContent = "Current round";

    const orderedRows = [...rows].sort((a, b) => {
      if (a.hasGuess === b.hasGuess) return a.player.name.localeCompare(b.player.name);
      return a.hasGuess ? 1 : -1;
    });

    const html = orderedRows.map(row => {
      const statusText = row.hasGuess
        ? "Done"
        : (isTimerExpired() || !state.game.acceptingGuesses) ? "Missed" : "Still guessing";
      const statusClass = row.hasGuess ? "done" : "waiting";
      const subText = row.hasGuess
        ? "Guess submitted"
        : (isTimerExpired() || !state.game.acceptingGuesses) ? "No guess. Nil points." : "Waiting for guess";

      return `
        <div class="result live-result guess-status-row ${statusClass}">
          <div class="guess-status-line">
            <div>
              <strong>${playerLabel(row.player)}</strong>
              <p class="small muted">${subText}</p>
            </div>
            <span class="guess-status-badge ${statusClass}">${row.hasGuess ? "✅" : "⏳"} ${statusText}</span>
          </div>
        </div>
      `;
    }).join("");

    setHtmlIfChanged(resultsList, html, state.game.revealed ? "roundResultsRevealed" : "roundResultsLive");
    return;
  }

  if (isSolo) {
    $("roundResultsTitle").textContent = "Your round result";
    const row = rows[0];
    const question = currentQuestion();
    const verdict = row?.hasGuess ? verdictForRow(row, question) : "No guess submitted. Bottle job.";
    const html = `
      <div class="result solo-result-card">
        <div class="solo-result-top">
          <div>
            <strong>${row?.player ? playerLabel(row.player) : "You"}</strong>
            <p class="small muted">${distanceTextForRow(row, question)}</p>
          </div>
          <div class="round-points">${row?.hasGuess ? row.points : 0}</div>
        </div>
        <p class="small muted solo-verdict">${row?.hasGuess ? escapeHtml(verdict) : "No guess submitted - Bottle job."}</p>
        <p class="small muted">Total score: ${row?.player?.total || 0}</p>
      </div>
    `;
    setHtmlIfChanged(resultsList, html, "soloRoundResult");
    return;
  }

  $("roundResultsTitle").textContent = "Round banter";
  const awards = roundAwards(rows);
  const html = awards + rows.map((row, index) => `
    <div class="result">
      <div class="round-result-row">
        <div class="round-rank">${index + 1}</div>
        <div>
          <strong>${playerLabel(row.player)}</strong>
          <p class="small muted">${row.hasGuess ? `${distanceTextForRow(row, currentQuestion())} - ${verdictForRow(row, currentQuestion())}` : "No guess submitted - Bottle job."}</p>
        </div>
        <div class="round-points">${row.hasGuess ? row.points : 0}</div>
      </div>
    </div>
  `).join("");

  setHtmlIfChanged(resultsList, html, state.game.revealed ? "roundResultsRevealed" : "roundResultsLive");
}


function isFinalRevealState() {
  return isFinalScoredRound();
}

function finalOverlayKey() {
  if (!isFinalRevealState()) return null;
  return `${state.gameCode}-${state.game.currentRound}-final`;
}

function hideFinalOverlay(resetTimer = true) {
  const overlay = $("finalLeaderboardOverlay");
  if (!overlay) return;
  document.body.classList.remove("final-overlay-active");
  document.body.classList.remove("final-overlay-active");
  overlay.classList.add("hidden");
  overlay.classList.remove("show");
  overlay.innerHTML = "";
  state.renderCache.finalMapOverlay = "";
  state.finalOverlayVisibleKey = null;
  state.finalOverlayPendingKey = null;

  if (resetTimer && state.finalOverlayTimer) {
    clearTimeout(state.finalOverlayTimer);
    state.finalOverlayTimer = null;
  }
}


function renderRoundSpotlight() {
  const overlay = $("roundSpotlightOverlay");
  if (!overlay) return;

  if (isFinalRevealState() && state.finalOverlayVisibleKey === finalOverlayKey()) {
    overlay.classList.add("hidden");
    overlay.innerHTML = "";
    return;
  }

  if (isSoloGame()) {
    overlay.classList.add("hidden");
    overlay.innerHTML = "";
    return;
  }

  if (!state.game?.revealed) {
    overlay.classList.add("hidden");
    overlay.innerHTML = "";
    return;
  }

  const rows = roundRows().filter(row => row.hasGuess);
  if (!rows.length) {
    overlay.classList.add("hidden");
    overlay.innerHTML = "";
    return;
  }

  const { best, worst } = bestAndWorstRows(rows);
  if (!best) {
    overlay.classList.add("hidden");
    overlay.innerHTML = "";
    return;
  }

  const question = currentQuestion();
  const isCountry = question?.type === "country";
  const everyoneInside = isCountry && rows.length > 1 && rows.every(r => r.inside);
  const allTiedTop = rows.length > 1 && rows.every(r => r.points === best.points);
  const allTiedBottom = rows.length > 1 && rows.every(r => r.points === worst.points) && best.points === worst.points;
  const isJointRound = everyoneInside || allTiedTop || allTiedBottom;
  const isBestYou = best.player.id === state.playerId;
  const isWorstYou = worst.player.id === state.playerId && worst.player.id !== best.player.id;
  const meRow = rows.find(r => r.player.id === state.playerId) || null;
  const youInJoint = isJointRound && Boolean(meRow);

  // Joint round: everyone tied. Render one shared celebration card so we
  // don't unfairly "roast" a player who scored exactly the same as the
  // best guess. Especially important in country mode where multiple
  // players can land inside the same polygon and all earn 1000.
  if (isJointRound) {
    let kicker;
    let verdict;
    if (everyoneInside) {
      kicker = "🎯 All inside the country";
      verdict = rows.length === 2
        ? "Both pins landed inside. Joint full marks."
        : `All ${rows.length} pins inside the country. Honours even.`;
    } else if (allTiedTop && best.points >= 950) {
      kicker = "🎯 Joint best";
      verdict = "Everyone tied at the top. No roast this round.";
    } else if (allTiedBottom && worst.points <= 60) {
      kicker = "🌍 Everyone miles off";
      verdict = "Same continent? Different planet. No single roast - it's a group effort.";
    } else {
      kicker = "🤝 Round tied";
      verdict = "Everyone scored the same. Round called even.";
    }
    const namesHtml = rows.map(r => `
      <span class="round-spotlight-tied-player">
        <span class="round-spotlight-avatar small">${r.player.avatar || "🌍"}</span>
        <span class="round-spotlight-name">${escapeHtml(r.player.name)}</span>
      </span>
    `).join("");
    const html = `
      <div class="round-spotlight-card best joint ${youInJoint ? "is-you" : ""}">
        <div class="round-spotlight-kicker">${kicker} ${youInJoint ? '<span class="spotlight-you-pill">You</span>' : ""}</div>
        <div class="round-spotlight-head">
          <div class="round-spotlight-tied-list">${namesHtml}</div>
          <div class="round-spotlight-points">+${best.points || 0}</div>
        </div>
        <div class="round-spotlight-verdict">${escapeHtml(verdict)}</div>
      </div>
    `;
    setHtmlIfChanged(overlay, html, "roundSpotlightOverlay");
    overlay.classList.remove("hidden");
    return;
  }

  const bestHtml = `
    <div class="round-spotlight-card best ${isBestYou ? "is-you" : ""}">
      <div class="round-spotlight-kicker">🏆 Best guess ${isBestYou ? '<span class="spotlight-you-pill">You</span>' : ""}</div>
      <div class="round-spotlight-head">
        <div class="round-spotlight-avatar">${best.player.avatar || "🌍"}</div>
        <div>
          <div class="round-spotlight-name">${escapeHtml(best.player.name)}</div>
          <div class="round-spotlight-meta">${distanceTextForRow(best, question)}</div>
        </div>
        <div class="round-spotlight-points">+${best.points || 0}</div>
      </div>
      <div class="round-spotlight-verdict">${escapeHtml(bestSpotlightForRow(best, question))}</div>
    </div>
  `;

  let worstHtml = "";
  if (worst && worst.player.id !== best.player.id) {
    worstHtml = `
      <div class="round-spotlight-card worst ${isWorstYou ? "is-you" : ""}">
        <div class="round-spotlight-kicker">🥄 Roast of the round ${isWorstYou ? '<span class="spotlight-you-pill">You</span>' : ""}</div>
        <div class="round-spotlight-head">
          <div class="round-spotlight-avatar">${worst.player.avatar || "🌍"}</div>
          <div>
            <div class="round-spotlight-name">${escapeHtml(worst.player.name)}</div>
            <div class="round-spotlight-meta">${distanceTextForRow(worst, question)}</div>
          </div>
          <div class="round-spotlight-points">+${worst.points || 0}</div>
        </div>
        <div class="round-spotlight-verdict">${escapeHtml(worstSpotlightForRow(worst, question))}</div>
      </div>
    `;
  }

  const html = bestHtml + worstHtml;
  setHtmlIfChanged(overlay, html, "roundSpotlightOverlay");
  overlay.classList.remove("hidden");
}


function trackGameCompletedOnce() {
  if (!state.gameCode || !state.game) return;

  const key = `game_completed_${state.gameCode}`;
  if (state.renderCache[key]) return;
  state.renderCache[key] = "sent";

  if (isSoloGame()) {
    recordSoloResultIfNeeded();
  }

  trackEvent("game_completed", {
    code: state.gameCode,
    player_count: playersArray().length,
    round_count: state.game?.roundsRequested || state.game?.questions?.length,
    question_type: state.game?.questionType,
    difficulty: state.game?.cityDifficulty,
    tone_mode: state.game?.toneMode,
    map_mode: state.game?.mapMode,
    scoring_mode: state.game?.scoringMode,
    daily_challenge: Boolean(state.game?.dailyChallenge),
    daily_date: state.game?.dailyDate || null,
    setup_key: isSoloGame() ? soloSetupKey(state.game) : undefined,
    is_solo: isSoloGame()
  });
}

// Records the daily result exactly once per gameCode. Returns the
// updated state with isNewBestForDay + streakChanged flags so the
// overlay can show appropriate copy.
function recordDailyResultIfNeeded() {
  if (!isDailyGame() || !isFinalRevealState()) return null;
  const cacheKey = `daily_recorded_${state.gameCode}`;
  if (state.renderCache[cacheKey]) return state.renderCache[cacheKey + ":result"];
  state.renderCache[cacheKey] = "sent";
  const dailyDate = state.game?.dailyDate || todayUtcDateString();
  const finalScore = currentSoloScore();
  const result = recordDailyCompletion(dailyDate, finalScore);
  state.renderCache[cacheKey + ":result"] = result;
  trackEvent?.("daily_challenge_completed", {
    daily_date: dailyDate,
    score: finalScore,
    streak: result.currentStreak,
    longest_streak: result.longestStreak,
    is_new_best_for_day: result.isNewBestForDay,
    streak_changed: result.streakChanged
  });
  return result;
}

// Web Share API with a clipboard fallback. Returns "shared", "cancelled",
// "copied" or "failed". The native share sheet is preferred on iOS/Android
// since it offers iMessage / WhatsApp / Share via... directly. Desktop
// falls through to the clipboard path.
async function shareResults(opts = {}) {
  const text = opts.text || buildShareText();
  const url = opts.url || "https://pintheplanet.co.uk";
  const title = opts.title || "Pin the Planet";

  if (typeof navigator !== "undefined" && navigator.share) {
    try {
      await navigator.share({ title, text, url });
      trackEvent?.("results_shared", { method: "native", source: opts.source || "unknown" });
      return "shared";
    } catch (error) {
      // User dismissed the sheet - don't fall through to clipboard, that
      // would be confusing.
      if (error && (error.name === "AbortError" || /cancel/i.test(error.message || ""))) return "cancelled";
      // Other errors (permissions, broken implementation) fall through to clipboard.
    }
  }
  const fullText = `${text}\n${url}`.trim();
  const ok = await copyToClipboardWithFallback(fullText, "Copied — paste it anywhere");
  trackEvent?.("results_shared", { method: "clipboard", source: opts.source || "unknown", success: !!ok });
  return ok ? "copied" : "failed";
}

function buildShareText() {
  const game = state.game;
  if (!game) return "Just played Pin the Planet 🌍";
  const score = currentSoloScore();
  if (isDailyGame()) {
    const max = (game.questions?.length || 10) * 1000;
    const daily = readDailyState();
    const streak = Number(daily.currentStreak) || 0;
    const streakLine = streak > 1 ? ` (Day ${streak} streak 🔥)` : "";
    return `Just scored ${score.toLocaleString()}/${max.toLocaleString()} on today's Pin the Planet daily challenge${streakLine} 🌍`;
  }
  if (isSoloGame()) {
    const max = maxScoreForGame(game);
    return `Just scored ${score.toLocaleString()}/${max.toLocaleString()} on Pin the Planet 🌍 reckon you can beat me?`;
  }
  // Multiplayer.
  return "Just played Pin the Planet with mates 🌍 a quick map-guessing party game.";
}

function renderFinalMapOverlay() {
  if (typeof isFinalRevealState === "function" && isFinalRevealState()) trackGameCompletedOnce();
  const overlay = $("finalLeaderboardOverlay");
  if (!overlay) return;
  const spotlight = $("roundSpotlightOverlay");
  const key = finalOverlayKey();

  if (!key) {
    hideFinalOverlay();
    return;
  }

  if (spotlight && state.finalOverlayVisibleKey === key) {
    spotlight.classList.add("hidden");
  }

  const rows = roundRows();
  const roundPointsByPlayer = Object.fromEntries(rows.map(row => [row.player.id, row.points || 0]));
  const byTotal = displayablePlayers().sort((a, b) => (b.total || 0) - (a.total || 0));
  const showPubPoints = state.game.scoringMode === "pub";
  const isSolo = isSoloGame();
  const isDaily = isDailyGame();

  const soloScore = byTotal[0]?.total || 0;
  const soloPercent = scorePercent(soloScore, state.game);
  const soloBestResult = isSolo && !isDaily ? recordSoloResultIfNeeded() : null;
  const soloBest = isSolo && !isDaily ? getSoloBest(state.game) : null;
  const bestScore = soloBest?.bestScore || soloScore;
  const bestPercent = soloBest?.bestPercent || soloPercent;
  const isNewBest = Boolean(soloBestResult?.isNewBest);

  // Daily-specific result + streak. recordDailyResultIfNeeded is
  // idempotent per gameCode, so re-renders don't double-count.
  const dailyResult = isDaily ? recordDailyResultIfNeeded() : null;
  const dailyState = isDaily ? readDailyState() : null;
  const dailyDateKey = state.game?.dailyDate || (dailyResult ? dailyState?.lastPlayedDate : null);
  const dailyToday = dailyDateKey ? dailyState?.byDate?.[dailyDateKey] : null;
  const dailyMaxScore = (state.game?.questions?.length || 10) * 1000;
  const dailyStreak = Number(dailyResult?.currentStreak ?? dailyState?.currentStreak) || 0;
  const dailyLongest = Number(dailyResult?.longestStreak ?? dailyState?.longestStreak) || 0;
  const dailyIsNewBestForDay = Boolean(dailyResult?.isNewBestForDay);

  const html = isDaily ? `
    <div class="final-board solo-final-board daily-final-board">
      <div class="final-board-header">
        <div class="final-board-kicker">${dailyIsNewBestForDay ? "🏆 New best for today" : "🌍 Daily challenge complete"}</div>
        <div class="final-board-title">${soloScore.toLocaleString()}<span class="daily-of-max"> / ${dailyMaxScore.toLocaleString()}</span></div>
        <div class="final-board-subtitle">${dailyDateKey ? `Daily pack for ${formatDailyDateForDisplay(dailyDateKey)}` : "Daily pack"}. Same questions for every player today.</div>
      </div>
      <div class="final-board-list final-board-list-solo">
        <div class="final-board-row champion solo">
          <div class="final-place">🔥</div>
          <div>
            <div class="final-player-name">Day ${dailyStreak} streak</div>
            <div class="final-player-meta">${dailyLongest > dailyStreak ? `Longest: ${dailyLongest} days` : (dailyStreak === 1 ? "Streak started - come back tomorrow" : "Best streak yet")}</div>
          </div>
          <div class="final-total-wrap">
            <div class="final-total">${dailyStreak}</div>
            <div class="final-round-add">${dailyStreak === 1 ? "day" : "days"}</div>
          </div>
        </div>
        <div class="final-board-row solo-best-row">
          <div class="final-place">⭐</div>
          <div>
            <div class="final-player-name">Today's best</div>
            <div class="final-player-meta">${dailyToday?.attempts ? `${dailyToday.attempts} ${dailyToday.attempts === 1 ? "attempt" : "attempts"}` : "First attempt"}</div>
          </div>
          <div class="final-total-wrap">
            <div class="final-total">${Number(dailyToday?.bestScore || soloScore).toLocaleString()}</div>
            <div class="final-round-add">${scorePercent(dailyToday?.bestScore || soloScore, state.game)}%</div>
          </div>
        </div>
      </div>
      <div class="final-board-actions">
        <button id="finalShareBtn" class="success">🔗 Share score</button>
        <button id="finalCopyResultsBtn" class="secondary">Copy results</button>
        ${state.isHost ? `<button id="finalDailyReplayBtn" class="secondary">Try again</button>` : ""}
      </div>
    </div>
  ` : isSolo ? `
    <div class="final-board solo-final-board">
      <div class="final-board-header">
        <div class="final-board-kicker">${isNewBest ? "🏆 New best run" : "🎯 Solo run complete"}</div>
        <div class="final-board-title">${soloScore.toLocaleString()}</div>
        <div class="final-board-subtitle">${soloPercent}% of the maximum score for this ${soloSetupLabel(state.game)}.</div>
      </div>
      <div class="final-board-list final-board-list-solo">
        <div class="final-board-row champion solo">
          <div class="final-place">${byTotal[0]?.avatar || "🌍"}</div>
          <div>
            <div class="final-player-name">${playerLabel(byTotal[0])}</div>
            <div class="final-player-meta">${isNewBest ? "New best for this setup" : "Your final score for this run"}</div>
          </div>
          <div class="final-total-wrap">
            <div class="final-total">${soloPercent}%</div>
            <div class="final-round-add">${isPracticeRound() ? "practice only" : `+${roundPointsByPlayer[byTotal[0]?.id] || 0} this round`}</div>
          </div>
        </div>
        <div class="final-board-row solo-best-row">
          <div class="final-place">⭐</div>
          <div>
            <div class="final-player-name">Best for this setup</div>
            <div class="final-player-meta">${soloSetupLabel(state.game)} · ${soloBest?.gamesPlayed || 1} ${Number(soloBest?.gamesPlayed || 1) === 1 ? "run" : "runs"}</div>
          </div>
          <div class="final-total-wrap">
            <div class="final-total">${Number(bestScore || 0).toLocaleString()}</div>
            <div class="final-round-add">${bestPercent}% best</div>
          </div>
        </div>
      </div>
      <div class="final-board-actions">
        <button id="finalShareBtn" class="secondary">🔗 Share</button>
        <button id="finalCopyResultsBtn" class="secondary">Copy results</button>
        ${state.isHost ? `<button id="finalNewGameBtn" class="success">Play solo again</button>` : ""}
      </div>
    </div>
  ` : `
    <div class="final-board">
      <div class="final-board-header">
        <div class="final-board-kicker">🏁 Final leaderboard</div>
        <div class="final-board-title">Game over</div>
        <div class="final-board-subtitle">${showPubPoints ? "Pub quiz result points are shown beside the distance score." : "Final scores are in. Screenshot it before the excuses start."}</div>
      </div>
      <div class="final-board-list">
        ${byTotal.map((player, index) => {
          const isChampion = index === 0;
          const isSpoon = index === byTotal.length - 1 && byTotal.length > 1;
          const placeBadge = isChampion ? "🏆" : isSpoon ? "🥄" : `${index + 1}`;
          const placeLabel = isChampion ? "Champion" : isSpoon ? "Wooden spoon" : `${index + 1}${index === 1 ? "nd" : index === 2 ? "rd" : "th"} place`;
          return `
            <div class="final-board-row ${isChampion ? "champion" : ""} ${isSpoon ? "spoon" : ""}">
              <div class="final-place">${placeBadge}</div>
              <div>
                <div class="final-player-name">${playerLabel(player)}</div>
                <div class="final-player-meta">${placeLabel}${showPubPoints ? ` · ${pubQuizPointsForIndex(index)} pub points` : ""}</div>
              </div>
              <div class="final-total-wrap">
                <div class="final-total">${player.total || 0}</div>
                <div class="final-round-add">${isPracticeRound() ? "practice only" : `+${roundPointsByPlayer[player.id] || 0} this round`}</div>
              </div>
            </div>
          `;
        }).join("")}
      </div>
      <div class="final-board-actions">
        <button id="finalShareBtn" class="secondary">🔗 Share</button>
        <button id="finalCopyResultsBtn" class="secondary">Copy results</button>
        ${state.isHost ? `<button id="finalNewGameBtn" class="success">Play again with same group</button>` : ""}
      </div>
    </div>
  `;
  setHtmlIfChanged(overlay, html, "finalMapOverlay");

  if (state.finalOverlayVisibleKey === key) {
    overlay.classList.remove("hidden");
    document.body.classList.add("final-overlay-active");
    requestAnimationFrame(() => overlay.classList.add("show"));
    return;
  }

  overlay.classList.add("hidden");
  overlay.classList.remove("show");

  if (state.finalOverlayPendingKey !== key) {
    if (state.finalOverlayTimer) clearTimeout(state.finalOverlayTimer);
    state.finalOverlayPendingKey = key;
    state.finalOverlayTimer = setTimeout(() => {
      state.finalOverlayVisibleKey = key;
      state.finalOverlayPendingKey = null;
      state.finalOverlayTimer = null;
      renderFinalMapOverlay();
    }, 5000);
  }
}

function renderLeaderboard() {
  if (!state.game?.started) {
    $("leaderboardPanel").classList.add("hidden");
    return;
  }

  const isFinal = isFinalScoredRound();
  const rows = roundRows();
  const byTotal = displayablePlayers().sort((a, b) => (b.total || 0) - (a.total || 0));
  const panel = $("leaderboardPanel");
  const isSolo = isSoloGame();
  panel.classList.remove("hidden");
  panel.classList.toggle("final", isFinal);
  panel.classList.toggle("solo", isSoloGame());
  panel.classList.toggle("solo", isSolo);

  const title = isSolo
    ? (isFinal ? "🎯 Solo run complete" : state.game.revealed ? `📈 Your score after ${roundLabel()}` : "📈 Your score so far")
    : isPracticeRound()
      ? "🧪 Practice round"
      : isFinal
        ? "🏁 Final leaderboard"
        : state.game.revealed
          ? `📊 Leaderboard after ${roundLabel()}`
          : "📊 Leaderboard so far";

  const soloBest = isSolo ? getSoloBest(state.game) : null;
  const subtitle = isSolo
    ? (soloBest?.bestScore ? `Best for this setup: ${soloBest.bestScore.toLocaleString()} (${soloBest.bestPercent || scorePercent(soloBest.bestScore, state.game)}%).` : (isFinal ? "Your final total for this run." : state.game.revealed ? "Your cumulative score, including this round." : "Track your running total as you go."))
    : isPracticeRound()
      ? "Practice round only - these points will not count."
      : isFinal
        ? "Game over. Screenshot this before the excuses start."
        : state.game.revealed
          ? "Cumulative scores, with this round shown underneath."
          : "Current cumulative scores.";

  const roundPointsByPlayer = Object.fromEntries(rows.map(row => [row.player.id, row.points || 0]));
  const html = `
    <div>
      <div class="leader-title">${title}</div>
      <p class="small muted">${subtitle}</p>
    </div>
    <div class="stack">
      ${byTotal.map((player, index) => `
        <div class="leader-row ${isSolo ? "solo-row" : ""}">
          <div>
            <strong>${isSolo ? playerLabel(player) : `${index + 1}. ${playerLabel(player)}`}</strong>
            ${state.game.revealed ? `<span class="small round-score">${isPracticeRound() ? "practice only" : `+${roundPointsByPlayer[player.id] || 0} this round`}</span>` : `<span class="small muted">${isSolo ? "Round live" : "Waiting for reveal"}</span>`}
          </div>
          <div class="score">${player.total || 0}</div>
        </div>
      `).join("")}
    </div>
  `;
  setHtmlIfChanged(panel, html, isSolo ? "soloLeaderboard" : "leaderboard");
}

function roundAwards(rows) {
  const guessed = rows.filter(row => row.hasGuess);
  if (!guessed.length) {
    return `<div class="result"><strong>🏆 Round awards</strong><p class="small muted">Nobody guessed. Stunning commitment to the bit.</p></div>`;
  }

  const { best, worst } = bestAndWorstRows(rows);
  if (!best) {
    return `<div class="result"><strong>🏆 Round awards</strong><p class="small muted">Nobody guessed. Stunning commitment to the bit.</p></div>`;
  }

  const awardQuestion = currentQuestion();
  const isCountry = awardQuestion?.type === "country";
  const everyoneInside = isCountry && guessed.length > 1 && guessed.every(r => r.inside);
  const allTied = guessed.length > 1 && guessed.every(r => r.points === best.points);

  // Joint round: don't crown a wooden spoon when everyone tied.
  if (everyoneInside || allTied) {
    const namesList = guessed.map(r => playerLabel(r.player)).join(", ");
    let line;
    if (everyoneInside) {
      line = guessed.length === 2
        ? `Both inside the country: ${namesList}. Joint full marks.`
        : `All inside the country: ${namesList}. Joint full marks.`;
    } else if (best.points <= 60) {
      line = `Everyone miles off: ${namesList}. Honours even.`;
    } else {
      line = `Joint best: ${namesList}. Round called even.`;
    }
    return `<div class="result"><strong>🏆 Round awards</strong><p class="small muted">${line}</p></div>`;
  }

  let html = `<div class="result"><strong>🏆 Round awards</strong>`;
  html += `<p class="small muted">Closest: ${playerLabel(best.player)} - ${distanceTextForRow(best, awardQuestion).toLowerCase()}.</p>`;
  if (worst && worst.player.id !== best.player.id) {
    html += `<p class="small muted">Wooden spoon: ${playerLabel(worst.player)} - ${distanceTextForRow(worst, awardQuestion).toLowerCase()}.</p>`;
  }
  html += `</div>`;
  return html;
}

function playerEmojiIcon(row, rank, worstId) {
  const isBest = rank === 0;
  const isWorst = row.player.id === worstId && !isBest;
  const classes = ["player-emoji-pin"];
  if (isBest) classes.push("best");
  if (isWorst) classes.push("worst");

  const safeName = escapeHtml(markerName(row.player));
  return L.divIcon({
    className: "player-emoji-marker",
    html: `
      <div class="player-emoji-chip">
        <div class="${classes.join(" ")}" title="${escapeHtml(row.player.name)}">${row.player.avatar || "🌍"}</div>
        <div class="player-emoji-name ${isBest ? "best" : ""} ${isWorst ? "worst" : ""}" title="${escapeHtml(row.player.name)}">${safeName}</div>
      </div>
    `,
    iconSize: [170, 42],
    iconAnchor: [21, 21],
    popupAnchor: [0, -22]
  });
}

function renderPersonalResult() {
  const card = $("personalResultCard");
  if (!state.game?.revealed || isFinalRevealState()) {
    card.classList.add("hidden");
    card.innerHTML = "";
    return;
  }

  const rows = roundRows();
  const index = rows.findIndex(row => row.player.id === state.playerId);
  if (index === -1) {
    card.classList.add("hidden");
    card.innerHTML = "";
    return;
  }

  const row = rows[index];
  const rank = index + 1;
  const total = rows.length;
  const best = rows[0];
  const worst = rows[rows.length - 1];
  const isInSpotlight = row.player.id === best.player.id || row.player.id === worst.player.id;

  if (!isSoloGame() && isInSpotlight) {
    card.classList.add("hidden");
    card.innerHTML = "";
    return;
  }

  const personalQuestion = currentQuestion();
  const verdict = row.hasGuess ? verdictForRow(row, personalQuestion) : "No guess submitted. Bottle job.";

  card.classList.remove("hidden");
  const html = `
    <div class="personal-result-inner">
      <div class="personal-result-emoji">${row.player.avatar || "🌍"}</div>
      <div>
        <div class="personal-result-title">${isSoloGame() ? "Your round score" : "Your round result"}</div>
        <div class="personal-result-meta">${distanceTextForRow(row, personalQuestion)}</div>
        <div class="personal-result-verdict">${escapeHtml(verdict)}</div>
      </div>
      <div>
        <div class="personal-result-points">+${row.points || 0}</div>
        <div class="personal-result-rank">${isSoloGame() ? `Round ${state.game.currentRound + 1} of ${state.game.questions?.length || total}` : `Rank ${rank}/${total}`}</div>
      </div>
    </div>
  `;
  setHtmlIfChanged(card, html, "personalResult");
}

function renderMapMarkers() {
  if (!state.map || !state.game) return;
  const question = currentQuestion();

  if (state.answerMarker) {
    state.answerMarker.remove();
    state.answerMarker = null;
  }
  if (state.countryShape) {
    state.countryShape.remove();
    state.countryShape = null;
  }
  state.guessLines.forEach(line => line.remove());
  state.revealMarkers.forEach(marker => marker.remove());
  state.guessLines = [];
  state.revealMarkers = [];

  if (state.game.revealed && question) {
    if (question.type === "country" && question.geometry) {
      try {
        state.countryShape = L.geoJSON(question.geometry, {
          style: {
            color: "#ff7b00",
            weight: 2,
            fillColor: "#ff7b00",
            fillOpacity: 0.18
          }
        }).addTo(state.map);
      } catch (error) {
        // Drawing the outline is a nicety. Don't break reveal if it fails.
      }
    }

    state.answerMarker = L.marker([question.lat, question.lng], { icon: markerIcons.answer, zIndexOffset: 900 })
      .bindPopup(`<strong>Answer:</strong> ${escapeHtml(locationDisplayName(question))}`)
      .addTo(state.map);

    const rows = roundRows().filter(row => row.hasGuess);
    const rowsByDistance = roundRowsByDistance(rows);
    const worstRow = rowsByDistance.length ? rowsByDistance[rowsByDistance.length - 1] : null;

    rows.forEach((row) => {
      const distanceRank = Math.max(0, rowsByDistance.findIndex(distanceRow => distanceRow.player.id === row.player.id));
      const wrappedGuess = wrappedGuessForAnswer(row.guess, question);
      const popupDistance = question.type === "country"
        ? (row.inside ? "inside the country" : `${Math.round(row.distance).toLocaleString()} km from the border`)
        : `${Math.round(row.distance).toLocaleString()} km`;

      const marker = L.marker([wrappedGuess.lat, wrappedGuess.lng], {
        icon: playerEmojiIcon(row, distanceRank, worstRow?.player?.id),
        zIndexOffset: 700 + (rows.length - distanceRank)
      })
        .bindPopup(`<strong>${escapeHtml(row.player.name)}</strong><br>+${row.points} · ${popupDistance}`)
        .addTo(state.map);

      state.revealMarkers.push(marker);

      // For country mode, skip the connector line when the pin is inside the
      // country - the line just clutters the outline. For city mode and
      // outside-country pins, the line reads as the distance trail.
      if (!(question.type === "country" && row.inside)) {
        const line = L.polyline([[wrappedGuess.lat, wrappedGuess.lng], [question.lat, question.lng]], {
          weight: 3,
          opacity: 0.62,
          noClip: true
        }).addTo(state.map);
        state.guessLines.push(line);
      }
    });

    const points = [[question.lat, question.lng], ...rows.map(row => {
      const wrappedGuess = wrappedGuessForAnswer(row.guess, question);
      return [wrappedGuess.lat, wrappedGuess.lng];
    })];

    if (question.type === "country" && state.countryShape) {
      try {
        const shapeBounds = state.countryShape.getBounds();
        const combined = points.length > 1 ? shapeBounds.extend(L.latLngBounds(points)) : shapeBounds;
        state.map.fitBounds(combined.pad(0.18), { animate: true, duration: 0.55, maxZoom: 5 });
      } catch (error) {
        if (points.length > 1) {
          state.map.fitBounds(L.latLngBounds(points).pad(0.32), { animate: true, duration: 0.55, maxZoom: 5 });
        }
      }
    } else if (points.length > 1) {
      const bounds = L.latLngBounds(points);
      state.map.fitBounds(bounds.pad(0.32), { animate: true, duration: 0.55, maxZoom: 5 });
    }
  }
}

async function startRound() {
  const durationMs = (state.game?.roundDurationSeconds || ROUND_DURATION_SECONDS) * 1000;
  const now = Date.now();
  const roundPlayerIds = Object.fromEntries(onlinePlayersArray().map(player => [player.id, true]));

  await remove(ref(db, `games/${state.gameCode}/guesses/${state.game.currentRound}`));
  await update(ref(db, `games/${state.gameCode}`), {
    started: true,
    acceptingGuesses: true,
    revealed: false,
    roundStartedAt: now,
    roundEndsAt: now + durationMs,
    roundClosedAt: null,
    roundClosedReason: null,
    roundPlayerIds
  });
  state.autoClosingRoundKey = null;
  clearOwnGuessMarker();
  if (window.matchMedia("(max-width: 860px)").matches) {
    requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" }));
  }
}

async function revealRound() {
  if (!state.game || !state.isHost) return;
  const question = currentQuestion();
  if (!question) return;

  if (state.game.acceptingGuesses && hasRoundTimerEnded()) {
    // Timer has ended but the round was still marked as accepting guesses.
    // Close it here so the host can always reveal after time is up.
    await update(ref(db, `games/${state.gameCode}`), {
      acceptingGuesses: false,
      roundClosedAt: Date.now(),
      roundClosedReason: "time-up"
    });
  }

  const guesses = guessesForCurrentRound();
  const players = playersArray();
  const playerUpdates = {};

  players.forEach(player => {
    const guess = guesses[player.id];
    const score = guess ? scoreGuessForQuestion(guess, question) : { points: 0 };
    const points = score.points || 0;
    if (!isPracticeRound()) {
      playerUpdates[`players/${player.id}/total`] = (player.total || 0) + points;
    }
  });

  await update(ref(db, `games/${state.gameCode}`), {
    acceptingGuesses: false,
    revealed: true,
    ...playerUpdates
  });
}

async function nextRound() {
  if (!state.game) return;
  const next = state.game.currentRound + 1;
  if (next >= state.game.questions.length) {
    toast("That was the final round");
    return;
  }

  const durationMs = (state.game.roundDurationSeconds || ROUND_DURATION_SECONDS) * 1000;
  const now = Date.now();
  const roundPlayerIds = Object.fromEntries(onlinePlayersArray().map(player => [player.id, true]));

  await update(ref(db, `games/${state.gameCode}`), {
    currentRound: next,
    acceptingGuesses: true,
    revealed: false,
    started: true,
    roundStartedAt: now,
    roundEndsAt: now + durationMs,
    roundClosedAt: null,
    roundClosedReason: null,
    roundPlayerIds
  });
  state.autoClosingRoundKey = null;
  clearOwnGuessMarker();
  if (window.matchMedia("(max-width: 860px)").matches) {
    requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" }));
  }
}

async function resetGame() {
  if (!state.isHost || !state.game) return;
  const playerUpdates = {};
  Object.keys(state.game.players || {}).forEach(playerId => {
    playerUpdates[`players/${playerId}/total`] = 0;
  });
  await update(ref(db, `games/${state.gameCode}`), {
    currentRound: 0,
    acceptingGuesses: false,
    revealed: false,
    started: false,
    roundStartedAt: null,
    roundEndsAt: null,
    roundClosedAt: null,
    roundClosedReason: null,
    roundPlayerIds: null,
    guesses: null,
    ...playerUpdates
  });
  clearOwnGuessMarker();
}

function clearOwnGuessMarker() {
  state.renderCache = {};
  hideFinalOverlay();
  const personal = $("personalResultCard");
  if (personal) {
    personal.classList.add("hidden");
    personal.innerHTML = "";
  }

  state.selectedGuess = null;
  if (state.guessMarker) {
    state.guessMarker.remove();
    state.guessMarker = null;
  }
}

function leaveGame(removeHostRoom = true) {
  hideFinalOverlay();
  document.body.classList.remove("has-mobile-host-bar");
  const code = state.gameCode;
  const playerId = state.playerId;
  const isHost = state.isHost;
  localStorage.removeItem("worldPinQuizSession");

  if (db && code && playerId) {
    if (isHost && removeHostRoom) remove(ref(db, `games/${code}`));
    else remove(ref(db, `games/${code}/players/${playerId}`));
  }

  window.location.href = window.location.pathname;
}




async function newGameSamePlayers() {
  if (!state.isHost || !state.game) return;

  const options = {
    roundsRequested: state.game.roundsRequested || scoredRoundTotal() || 10,
    roundDurationSeconds: state.game.roundDurationSeconds || ROUND_DURATION_SECONDS,
    practiceEnabled: Boolean(state.game.practiceEnabled),
    questionType: state.game.questionType || "city",
    cityDifficulty: state.game.cityDifficulty || "mixed",
    mapMode: state.game.mapMode || "hardcore",
    toneMode: state.game.toneMode || "lads",
    scoringMode: state.game.scoringMode || "distance",
    singlePlayer: Boolean(state.game.singlePlayer)
  };

  const questionCount = questionCountForOptions(options);
  toast("Fetching new questions...");

  let questions;
  try {
    questions = await fetchRandomQuestionsFromWikidata(questionCount, options);
  } catch (error) {
    toast("Question lookup failed. Try again.");
    return;
  }

  const playerUpdates = {};
  Object.keys(state.game.players || {}).forEach(playerId => {
    playerUpdates[`players/${playerId}/total`] = 0;
  });

  await update(ref(db, `games/${state.gameCode}`), {
    questions,
    singlePlayer: Boolean(state.game.singlePlayer),
    createdAt: Date.now(),
    currentRound: 0,
    acceptingGuesses: false,
    revealed: false,
    started: false,
    roundStartedAt: null,
    roundEndsAt: null,
    roundClosedAt: null,
    roundClosedReason: null,
    roundPlayerIds: null,
    guesses: null,
    ...playerUpdates
  });

  clearOwnGuessMarker();
  setTimeout(() => warmCityPool(questionCountForOptions(options), options).catch(() => {}), 250);
  toast("New game ready");
}


// --- Daily challenge storage + streak ----------------------------------
// Schema:
// {
//   byDate: { "YYYY-MM-DD": { bestScore, lastScore, attempts, completedAt } },
//   currentStreak: number,
//   longestStreak: number,
//   lastPlayedDate: "YYYY-MM-DD" | null,
//   totalCompleted: number
// }
// All dates are UTC ISO YYYY-MM-DD. Compared as strings - cheap and
// reliable. The dailyDate used for storage comes from the API response,
// not the client clock, so a midnight-crossover game still records
// against the date it was started under.
const DAILY_STORAGE_KEY = "pinThePlanetDaily";

function readDailyState() {
  try {
    const raw = JSON.parse(localStorage.getItem(DAILY_STORAGE_KEY) || "null");
    if (!raw || typeof raw !== "object") return emptyDailyState();
    return {
      byDate: raw.byDate && typeof raw.byDate === "object" ? raw.byDate : {},
      currentStreak: Number(raw.currentStreak) || 0,
      longestStreak: Number(raw.longestStreak) || 0,
      lastPlayedDate: typeof raw.lastPlayedDate === "string" ? raw.lastPlayedDate : null,
      totalCompleted: Number(raw.totalCompleted) || 0
    };
  } catch (error) {
    return emptyDailyState();
  }
}

function emptyDailyState() {
  return {
    byDate: {},
    currentStreak: 0,
    longestStreak: 0,
    lastPlayedDate: null,
    totalCompleted: 0
  };
}

function writeDailyState(state) {
  try {
    localStorage.setItem(DAILY_STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    // Storage failures must never break gameplay.
  }
}

function todayUtcDateString() {
  return new Date().toISOString().slice(0, 10);
}

// Turn an ISO date ("2026-05-04") into something a human reads
// without flinching ("Monday, 4 May"). Locale-aware so US / UK / EU
// users each see their preferred format. Falls back to the raw ISO
// string if the input is junk.
function formatDailyDateForDisplay(isoDate) {
  if (!isoDate || typeof isoDate !== "string") return "today";
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDate;
  try {
    return d.toLocaleDateString(undefined, {
      weekday: "long",
      day: "numeric",
      month: "long",
      timeZone: "UTC"
    });
  } catch (error) {
    return isoDate;
  }
}

function dateBefore(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Pure: compute the next daily state given a completion. Easier to reason
// about and unit-test than mutating the stored object directly.
function applyDailyCompletion(prev, dailyDate, finalScore) {
  const state = prev || emptyDailyState();
  const score = Number(finalScore) || 0;
  const dateKey = String(dailyDate || todayUtcDateString());
  const existing = state.byDate[dateKey] || { attempts: 0 };
  const isNewBestForDay = !existing.bestScore || score > existing.bestScore;
  const updatedDay = {
    bestScore: isNewBestForDay ? score : existing.bestScore,
    lastScore: score,
    attempts: (Number(existing.attempts) || 0) + 1,
    completedAt: new Date().toISOString()
  };

  const alreadyPlayedToday = state.lastPlayedDate === dateKey;
  let nextStreak;
  if (alreadyPlayedToday) {
    // Replay of the same daily date: streak unchanged.
    nextStreak = state.currentStreak;
  } else if (state.lastPlayedDate && state.lastPlayedDate === dateBefore(dateKey)) {
    // Played the previous day - streak continues.
    nextStreak = (state.currentStreak || 0) + 1;
  } else {
    // First play, or skipped one or more days - streak restarts.
    nextStreak = 1;
  }

  return {
    byDate: { ...state.byDate, [dateKey]: updatedDay },
    currentStreak: nextStreak,
    longestStreak: Math.max(nextStreak, state.longestStreak || 0),
    lastPlayedDate: dateKey,
    totalCompleted: (state.totalCompleted || 0) + 1,
    isNewBestForDay,
    streakChanged: !alreadyPlayedToday
  };
}

function recordDailyCompletion(dailyDate, finalScore) {
  const prev = readDailyState();
  const next = applyDailyCompletion(prev, dailyDate, finalScore);
  // Don't persist the transient flags.
  const { isNewBestForDay, streakChanged, ...persisted } = next;
  writeDailyState(persisted);
  return next;
}

function isDailyGame(game = state.game) {
  return Boolean(game?.dailyChallenge);
}

const SOLO_BESTS_STORAGE_KEY = "pinThePlanetSoloBests";

function soloSetupKey(game = state.game) {
  if (!game) return "unknown";

  return [
    game.questionType || "city",
    game.cityDifficulty || "mixed",
    game.mapMode || "hardcore",
    game.scoringMode || "distance",
    game.roundsRequested || scoredRoundTotal() || game.questions?.length || 10,
    game.practiceEnabled ? "practice" : "no-practice"
  ].join("|");
}

function soloSetupLabel(game = state.game) {
  if (!game) return "this setup";

  const rounds = game.roundsRequested || scoredRoundTotal() || game.questions?.length || 10;
  const difficulty = game.cityDifficulty || "mixed";
  const map = game.mapMode === "hardcore"
    ? "hardcore"
    : game.mapMode === "outlines"
      ? "outlines"
      : "labels";

  return `${rounds}-round ${difficulty}/${map} run`;
}

function maxScoreForGame(game = state.game) {
  const rounds = game?.roundsRequested || scoredRoundTotal() || game?.questions?.length || 1;
  return Math.max(1, rounds * 1000);
}

function scorePercent(score, game = state.game) {
  return Math.round((Number(score || 0) / maxScoreForGame(game)) * 100);
}

function readSoloBests() {
  try {
    return JSON.parse(localStorage.getItem(SOLO_BESTS_STORAGE_KEY) || "{}");
  } catch (error) {
    return {};
  }
}

function writeSoloBests(bests) {
  try {
    localStorage.setItem(SOLO_BESTS_STORAGE_KEY, JSON.stringify(bests));
  } catch (error) {
    // Ignore storage issues. Solo bests should never break the game.
  }
}

function getSoloBest(game = state.game) {
  return readSoloBests()[soloSetupKey(game)] || null;
}

function currentSoloScore() {
  const player = playersArray()[0];
  return Number(player?.total || 0);
}

function recordSoloResultIfNeeded() {
  if (!isSoloGame() || !isFinalScoredRound()) return null;

  const key = soloSetupKey(state.game);
  const bests = readSoloBests();
  const existing = bests[key] || {};
  const finalScore = currentSoloScore();
  const percent = scorePercent(finalScore, state.game);
  const isNewBest = !existing.bestScore || finalScore > existing.bestScore;

  const updated = {
    ...existing,
    setupKey: key,
    lastScore: finalScore,
    lastPercent: percent,
    gamesPlayed: Number(existing.gamesPlayed || 0) + 1,
    lastPlayedAt: new Date().toISOString(),
    questionType: state.game.questionType || "city",
    difficulty: state.game.cityDifficulty || "mixed",
    mapMode: state.game.mapMode || "hardcore",
    scoringMode: state.game.scoringMode || "distance",
    rounds: state.game.roundsRequested || scoredRoundTotal(),
    practiceEnabled: Boolean(state.game.practiceEnabled)
  };

  if (isNewBest) {
    updated.bestScore = finalScore;
    updated.bestPercent = percent;
    updated.bestDate = new Date().toISOString();
  }

  bests[key] = updated;
  writeSoloBests(bests);

  trackEvent?.("solo_game_completed", {
    score: finalScore,
    score_percent: percent,
    rounds: updated.rounds,
    question_type: updated.questionType,
    difficulty: updated.difficulty,
    map_mode: updated.mapMode,
    scoring_mode: updated.scoringMode,
    practice_enabled: updated.practiceEnabled,
    setup_key: key,
    best_for_setup: isNewBest,
    games_played_for_setup: updated.gamesPlayed
  });

  if (isNewBest) {
    trackEvent?.("solo_best_set", {
      score: finalScore,
      score_percent: percent,
      setup_key: key
    });
  }

  return { record: updated, isNewBest };
}


function finalSortedPlayers() {
  return playersArray().sort((a, b) => (b.total || 0) - (a.total || 0));
}

// Players safe to render in any user-facing leaderboard. Drops entries
// with no real name (which would otherwise render as "🌍 Player") -
// these come from stale Firebase records left by a player who left
// mid-game, or partial joins that didn't complete.
function displayablePlayers(players = playersArray()) {
  return players.filter(p => p && String(p.name || "").trim());
}

// Players safe to surface in copied/displayed final results: must have a
// real name, and must either be online or have actually scored. This
// drops stale duplicates that would otherwise read as "undefined: 0".
function validPlayersForResults(players = playersArray()) {
  const seen = new Set();
  const cleaned = [];
  const deduped = typeof dedupePlayersForDisplay === "function"
    ? dedupePlayersForDisplay(players)
    : players;
  for (const player of deduped) {
    if (!player) continue;
    const name = String(player.name || "").trim();
    if (!name) continue;
    const total = Number(player.total || 0);
    const isOnline = player.online !== false;
    if (!isOnline && total <= 0) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push({ ...player, name });
  }
  return cleaned;
}

function ordinal(rank) {
  if (rank === 1) return "1st";
  if (rank === 2) return "2nd";
  if (rank === 3) return "3rd";
  return `${rank}th`;
}

function buildResultsText() {
  const rows = validPlayersForResults().sort((a, b) => (b.total || 0) - (a.total || 0));
  const siteUrl = window.location.origin;
  const lines = ["🌍 Pin the Planet result"];

  if (rows.length) {
    lines.push("");
    rows.forEach((player, index) => {
      const badge = index === 0 ? "🏆" : index === rows.length - 1 && rows.length > 1 ? "🥄" : `${index + 1}.`;
      lines.push(`${badge} ${player.name}: ${player.total || 0}`);
    });
  }

  const currentRows = typeof roundRows === "function" ? roundRows().filter(row => row.hasGuess) : [];
  if (currentRows.length) {
    const best = currentRows[0];
    const worst = currentRows[currentRows.length - 1];
    const lastQuestion = currentQuestion();
    const isCountryRound = lastQuestion?.type === "country";
    const everyoneInside = isCountryRound && currentRows.length > 1 && currentRows.every(r => r.inside);
    const allTied = currentRows.length > 1 && currentRows.every(r => r.points === best.points);

    lines.push("");
    if (everyoneInside) {
      lines.push(`Final round: everyone landed inside the country. Joint full marks.`);
    } else if (allTied) {
      lines.push(`Final round: everyone tied at ${best.points}.`);
    } else {
      const bestSuffix = isCountryRound
        ? (best.inside ? "inside the country" : `${Math.round(best.distance).toLocaleString()}km from the border`)
        : `${Math.round(best.distance).toLocaleString()}km from ${locationDisplayName(lastQuestion) || "the answer"}`;
      lines.push(`Final round best: ${best.player.name} - ${bestSuffix}.`);

      if (worst && worst.player.id !== best.player.id) {
        const worstSuffix = isCountryRound
          ? (worst.inside ? "inside the country" : `${Math.round(worst.distance).toLocaleString()}km from the border`)
          : `${Math.round(worst.distance).toLocaleString()}km from ${locationDisplayName(lastQuestion) || "the answer"}`;
        lines.push(`Final round worst: ${worst.player.name} - ${worstSuffix}.`);
      }

      // "Most divisive" is only meaningful when the spread is non-trivial.
      // When the best is inside (distance 0) and the worst is e.g. 1,400km
      // out, "1,400km between best and worst" reads as a numeric oddity, so
      // skip it for that case.
      if (
        currentRows.length > 1 &&
        Number.isFinite(worst.distance) &&
        Number.isFinite(best.distance) &&
        !best.inside &&
        worst.distance - best.distance >= 200
      ) {
        const spread = Math.round((worst.distance - best.distance)).toLocaleString();
        lines.push(`Spread: ${spread}km between best and worst pins.`);
      }
    }
  }

  lines.push("");
  lines.push("");
  lines.push("Pin the place. Compare the carnage.");
  lines.push(`Play: ${siteUrl}`);

  return lines.join("\n");
}

function copyResults() {
  if (!state.game) return;
  const text = buildResultsText();

  copyToClipboardWithFallback(text, "Results copied").then((ok) => {
    trackEvent?.("results_copied", {
      code: state.gameCode,
      player_count: playersArray().length,
      clipboard_success: ok
    });
  });
}

function hostOwnGroup() {
  trackEvent?.("host_own_group_clicked", { code: state.gameCode });
  localStorage.removeItem("worldPinQuizSession");
  window.location.href = window.location.origin;
}

function currentJoinUrl() {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("room", state.gameCode || $("joinCode")?.value?.trim()?.toUpperCase() || "");
  return url.toString();
}

function copyToClipboardWithFallback(text, successMessage = "Copied") {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text)
      .then(() => {
        toast(successMessage);
        return true;
      })
      .catch(() => {
        window.prompt("Copy this", text);
        return false;
      });
  }

  window.prompt("Copy this", text);
  return Promise.resolve(false);
}

function copyJoinLink() {
  const link = currentJoinUrl();
  trackEvent?.("join_link_copied", { code: state.gameCode, link });
  copyToClipboardWithFallback(link, "Join link copied");
}




function setupSelectLabel(id) {
  const el = $(id);
  if (!el) return "";
  return el.options?.[el.selectedIndex]?.textContent?.trim() || el.value || "";
}

function renderDailyCard() {
  const card = $("dailyChallengeCard");
  if (!card) return;
  const today = todayUtcDateString();
  const daily = readDailyState();
  const playedToday = daily.byDate?.[today];
  const streak = Number(daily.currentStreak) || 0;
  const statusEl = $("dailyCardStatus");
  const titleEl = $("dailyCardTitle");
  const subtitleEl = $("dailyCardSubtitle");
  const btn = $("playDailyBtn");
  const chip = $("dailyStreakChip");

  if (titleEl) titleEl.textContent = `Today's pack · ${formatDailyDateForDisplay(today)}`;
  if (subtitleEl) subtitleEl.textContent = "5 cities, 5 countries · same questions for every player today.";

  if (playedToday) {
    if (statusEl) statusEl.textContent = `Best today: ${Number(playedToday.bestScore || 0).toLocaleString()} · ${playedToday.attempts} ${playedToday.attempts === 1 ? "attempt" : "attempts"}`;
    if (btn) btn.textContent = "Replay today's challenge";
  } else {
    if (statusEl) statusEl.textContent = "Not played yet today.";
    if (btn) btn.textContent = "Play today's challenge";
  }

  if (chip) {
    if (streak > 0 && daily.lastPlayedDate && (daily.lastPlayedDate === today || daily.lastPlayedDate === dateBefore(today))) {
      chip.classList.remove("hidden");
      chip.querySelector(".daily-streak-number").textContent = String(streak);
      chip.querySelector(".daily-streak-label").textContent = streak === 1 ? "day streak" : "day streak";
    } else {
      chip.classList.add("hidden");
    }
  }
}

function updateSetupSummary() {
  const title = $("setupSummaryTitle");
  const text = $("setupSummaryText");
  const duration = $("setupDurationPill");
  if (!title || !text) return;

  // Hide the City difficulty field when Countries is selected - it has
  // no effect on country-mode rounds.
  const isCountrySelected = $("questionType")?.value === "country";
  const diffField = $("cityDifficultyField");
  if (diffField) diffField.classList.toggle("hidden", isCountrySelected);

  // Keep the Question packs tiles in sync with the questionType dropdown.
  document.querySelectorAll(".pack-card[data-pack-type]").forEach(btn => {
    const packType = btn.getAttribute("data-pack-type");
    btn.classList.toggle("active", packType === ($("questionType")?.value || "city"));
  });

  const rounds = clamp(Number($("roundCount")?.value || 10), 1, 20);
  const timerSeconds = clamp(Number($("roundDuration")?.value || 30), 10, 60);
  const timer = setupSelectLabel("roundDuration") || "30 seconds";
  const practice = $("practiceRound")?.value === "on";
  const questionType = setupSelectLabel("questionType") || "World cities";
  const difficulty = setupSelectLabel("cityDifficulty") || "Mixed";
  const mapHelp = setupSelectLabel("mapMode") || "Hardcore - no borders";
  const tone = setupSelectLabel("toneMode") || "Lads mode";
  const scoring = setupSelectLabel("scoringMode") || "Distance points";

  const playableRounds = rounds + (practice ? 1 : 0);
  const approxMinutes = Math.max(1, Math.ceil((playableRounds * (timerSeconds + 12)) / 60));

  const toneSummary = tone === "Lads mode"
    ? "brutal roasts and pub-quiz banter"
    : tone === "Friendly"
      ? "friendly feedback"
      : "school-safe feedback";

  const mapSummary = mapHelp === "Hardcore - no borders"
    ? "a clean no-label map"
    : mapHelp === "Country outlines"
      ? "country outlines"
      : "easy labels";

  const difficultySummary = difficulty === "Familiar"
    ? "familiar city selection"
    : difficulty === "Chaos mode"
      ? "chaos-mode city selection"
      : "mixed city selection";

  const scoringSummary = scoring === "Pub quiz result points"
    ? "distance scores plus pub-quiz ranking points"
    : "distance points, with at least 50 for any submitted guess and zero for timeouts";

  const timerWarning = timerSeconds <= 10
    ? " 10 seconds is frantic - good for chaos, harsh for new players."
    : "";

  title.textContent = practice ? "Practice + game setup" : "Game setup";
  if (duration) duration.textContent = `~${approxMinutes} min`;
  const isCountryMode = $("questionType")?.value === "country";
  if (isCountryMode) {
    text.textContent = `${rounds} ${rounds === 1 ? "round" : "rounds"} of countries, ${timer.toLowerCase()} per round${practice ? ", plus a practice round first" : ""}. Country mode: click inside the country. Inside = full points. Expect ${mapSummary}, ${toneSummary}, and ${scoringSummary}.${timerWarning}`;
  } else {
    text.textContent = `${rounds} ${rounds === 1 ? "round" : "rounds"} of ${questionType.toLowerCase()}, ${timer.toLowerCase()} per round${practice ? ", plus a practice round first" : ""}. Expect ${difficultySummary}, ${mapSummary}, ${toneSummary}, and ${scoringSummary}.${timerWarning}`;
  }
}

function showSettingsDrawer(show = true) {
  $("settingsDrawer")?.classList.toggle("hidden", !show);
}

function showJoinPanel() {
  $("joinPanel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  $("playerName")?.focus();
}

$("customiseGameBtn")?.addEventListener("click", () => showSettingsDrawer(true));
$("closeSettingsBtn")?.addEventListener("click", () => showSettingsDrawer(false));
$("showJoinPanelBtn")?.addEventListener("click", showJoinPanel);
$("showHostSetupBtn")?.addEventListener("click", () => {
  document.body.classList.remove("join-link-mode");
  $("hostOwnGroupCard")?.classList.add("hidden");
  history.replaceState({}, "", window.location.pathname);
  $("hostSetupPanel")?.scrollIntoView({ behavior: "smooth", block: "start" });
});

// --- Setup persistence ----------------------------------------------------
const SETUP_PREFS_KEY = "pinThePlanetSetupPrefs";
const SETUP_PREF_FIELDS = [
  "hostName", "roundCount", "roundDuration", "practiceRound",
  "questionType", "cityDifficulty", "mapMode", "toneMode", "scoringMode"
];

function loadSetupPrefs() {
  try { return JSON.parse(localStorage.getItem(SETUP_PREFS_KEY) || "{}"); }
  catch { return {}; }
}

function saveSetupPrefs() {
  const prefs = {};
  for (const id of SETUP_PREF_FIELDS) {
    const el = $(id);
    if (!el) continue;
    prefs[id] = el.value;
  }
  try { localStorage.setItem(SETUP_PREFS_KEY, JSON.stringify(prefs)); }
  catch { /* storage full / private mode - ignore */ }
}

function applySetupPrefs(prefs) {
  if (!prefs || typeof prefs !== "object") return;
  for (const id of SETUP_PREF_FIELDS) {
    const el = $(id);
    if (!el) continue;
    const value = prefs[id];
    if (value === undefined || value === null || value === "") continue;
    if (el.tagName === "SELECT") {
      // Only apply if the option actually exists.
      if ([...el.options].some(opt => opt.value === String(value))) el.value = String(value);
    } else {
      el.value = String(value);
    }
  }
}

function clampRoundCountInput() {
  const el = $("roundCount");
  if (!el) return;
  const n = Number(el.value);
  if (!Number.isFinite(n) || n < 1) el.value = "1";
  else if (n > 20) el.value = "20";
}

// Apply persisted prefs on load (does not override join-link mode).
const isJoinLinkLoad = Boolean(new URLSearchParams(window.location.search).get("room"));
if (!isJoinLinkLoad) applySetupPrefs(loadSetupPrefs());

["roundCount", "roundDuration", "practiceRound", "questionType", "cityDifficulty", "mapMode", "toneMode", "scoringMode"].forEach((id) => {
  $(id)?.addEventListener("input", () => {
    if (id === "roundCount") clampRoundCountInput();
    updateSetupSummary();
    saveSetupPrefs();
  });
  $(id)?.addEventListener("change", () => {
    if (id === "roundCount") clampRoundCountInput();
    updateSetupSummary();
    saveSetupPrefs();
    if (typeof getSetupOptions === "function" && typeof warmCityPool === "function" && typeof questionCountForOptions === "function") {
      const options = getSetupOptions();
      warmCityPool(questionCountForOptions(options), options).catch(() => {});
    }
  });
});
$("hostName")?.addEventListener("change", saveSetupPrefs);
$("hostName")?.addEventListener("blur", saveSetupPrefs);

updateSetupSummary();

$("createGameBtn").addEventListener("click", () => createGame(false));
$("playSoloBtn").addEventListener("click", () => {
  // Belt-and-braces: ensure the click can never end up creating a
  // multiplayer room. We always pass true.
  createGame(true);
});

// Question pack tiles drive the questionType dropdown so the two stay
// in sync. Disabled "Soon" tiles are ignored.
document.querySelectorAll(".pack-card[data-pack-type]").forEach(btn => {
  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    const packType = btn.getAttribute("data-pack-type");
    const select = $("questionType");
    if (select && [...select.options].some(opt => opt.value === packType)) {
      select.value = packType;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
});
warmCityPool(questionCountForOptions(getSetupOptions()), getSetupOptions()).catch(() => {});
renderDailyCard();
$("roundDuration").addEventListener("change", () => {});
$("joinGameBtn").addEventListener("click", joinGame);
$("showHostSetupBtn")?.addEventListener("click", () => {
  document.body.classList.remove("join-link-mode");
  $("hostOwnGroupCard")?.classList.add("hidden");
  history.replaceState({}, "", window.location.pathname);
});
$("startRoundBtn").addEventListener("click", startRound);
$("restartRoundBtn").addEventListener("click", startRound);
$("revealBtn").addEventListener("click", revealRound);
$("nextRoundBtn").addEventListener("click", nextRound);
$("mobileStartBtn").addEventListener("click", startRound);
$("mobileRevealBtn").addEventListener("click", revealRound);
$("mobileNextBtn").addEventListener("click", nextRound);
$("mobileCopyBtn").addEventListener("click", copyJoinLink);
$("mobileNewGameBtn").addEventListener("click", newGameSamePlayers);
$("mobileCopyResultsBtn").addEventListener("click", copyResults);
$("newGameSamePlayersBtn").addEventListener("click", newGameSamePlayers);
$("copyResultsBtn").addEventListener("click", copyResults);
$("resetGameBtn").addEventListener("click", resetGame);
$("leaveBtn").addEventListener("click", () => leaveGame(true));
$("copyLinkBtn").addEventListener("click", copyJoinLink);
$("hostOwnGroupFinalBtn")?.addEventListener("click", hostOwnGroup);
$("newGameSamePlayersBtn")?.addEventListener("click", newGameSamePlayers);
$("copyResultsBtn")?.addEventListener("click", copyResults);
$("mobileHostOwnBtn")?.addEventListener("click", hostOwnGroup);
$("mobileNewGameBtn")?.addEventListener("click", newGameSamePlayers);
$("mobileCopyResultsBtn")?.addEventListener("click", copyResults);

$("joinCode").addEventListener("input", (event) => {
  event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
});

setInterval(() => {
  if (state.game?.started && !state.game.revealed) renderGame();
}, 500);

const roomFromUrl = new URLSearchParams(window.location.search).get("room");
if (roomFromUrl) {
  document.body.classList.add("join-link-mode");
  $("joinCode").value = roomFromUrl.toUpperCase();
  $("playerName")?.focus();
  $("hostOwnGroupCard")?.classList.remove("hidden");
  trackEvent?.("join_from_shared_link", { code: roomFromUrl.toUpperCase() });
}


window.addEventListener("resize", () => {
  if (state.game) renderMobileHostBar();
});

window.addEventListener("pagehide", trackRoomAbandoned);


document.addEventListener("click", (event) => {
  const target = event.target;
  if (!target?.id) return;

  if (target.id === "finalCopyResultsBtn") copyResults();
  if (target.id === "finalShareBtn") shareResults({ source: "final_overlay" });
  if (target.id === "finalDailyReplayBtn") {
    // Replay today's challenge - fresh game with same daily pack.
    leaveGame(true);
    setTimeout(() => playDailyChallenge(), 200);
  }
  if (target.id === "finalNewGameBtn") newGameSamePlayers();
  if (target.id === "finalHostOwnBtn") hostOwnGroup();
  if (target.id === "playDailyBtn") playDailyChallenge();
});


/* v42 mobile gesture hardening */
["gesturestart", "gesturechange", "gestureend"].forEach((eventName) => {
  window.addEventListener(eventName, (event) => {
    if (window.matchMedia("(max-width: 860px)").matches && document.body.classList.contains("in-game")) {
      event.preventDefault();
    }
  }, { passive: false });
});


/* v45 mobile gesture hardening */
["gesturestart", "gesturechange", "gestureend"].forEach((eventName) => {
  window.addEventListener(eventName, (event) => {
    if (window.matchMedia("(max-width: 860px)").matches && document.body.classList.contains("in-game")) {
      event.preventDefault();
    }
  }, { passive: false });
});


/* v45 round-timeout-watchdog */
setInterval(() => {
  if (!state.isHost || !state.game?.started || state.game.revealed || !state.game.acceptingGuesses) return;
  if (!hasRoundTimerEnded()) return;
  maybeAutoCloseRound();
}, 250);


function renderDebugPanel() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("debug") !== "1") return;

  let panel = document.getElementById("debugPanel");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "debugPanel";
    panel.className = "debug-panel";
    document.body.appendChild(panel);
  }

  const events = (() => {
    try { return JSON.parse(localStorage.getItem("pinThePlanetEvents") || "[]"); }
    catch { return []; }
  })();

  const soloBests = (() => {
    try { return JSON.parse(localStorage.getItem("pinThePlanetSoloBests") || "{}"); }
    catch { return {}; }
  })();

  const setupSnapshot = (() => {
    try { return getSetupOptions(); } catch { return null; }
  })();

  const gameSnapshot = state.game ? {
    singlePlayer: Boolean(state.game.singlePlayer),
    questionType: state.game.questionType || null,
    cityDifficulty: state.game.cityDifficulty || null,
    roundsRequested: state.game.roundsRequested || null,
    roundDurationSeconds: state.game.roundDurationSeconds || null,
    practiceEnabled: Boolean(state.game.practiceEnabled),
    mapMode: state.game.mapMode || null,
    toneMode: state.game.toneMode || null,
    scoringMode: state.game.scoringMode || null,
    started: Boolean(state.game.started),
    revealed: Boolean(state.game.revealed),
    currentRound: state.game.currentRound ?? null
  } : null;

  panel.innerHTML = `
    <strong>Debug</strong>
    <button id="debugCloseBtn" type="button">×</button>
    <pre>${escapeHtml(JSON.stringify({
      appVersion: PTP_APP_VERSION,
      room: state.gameCode,
      joinUrl: state.gameCode ? currentJoinUrl() : null,
      playerId: state.playerId,
      isHost: state.isHost,
      stage: currentAbandonStage?.(),
      setup: setupSnapshot,
      lastCreate: state.lastCreateOptions || null,
      game: gameSnapshot,
      events: events.slice(-10),
      soloBestKeys: Object.keys(soloBests)
    }, null, 2))}</pre>
  `;

  document.getElementById("debugCloseBtn")?.addEventListener("click", () => panel.remove());
}

setInterval(renderDebugPanel, 1500);


// Apply optional ?mode=solo URL overrides to the setup controls so a
// link like /?mode=solo&questionType=country&rounds=2&timer=10 starts a
// 2-round solo country game with a 10-second timer.
function applySoloUrlOverrides(params) {
  const setSelect = (id, value, allowed = null) => {
    const el = $(id);
    if (!el || value == null) return;
    const next = String(value).toLowerCase();
    if (allowed && !allowed.includes(next)) return;
    if (el.tagName === "SELECT") {
      if ([...el.options].some(opt => opt.value === next)) el.value = next;
    } else {
      el.value = next;
    }
  };

  if (params.has("questionType")) {
    setSelect("questionType", params.get("questionType"), ["city", "country"]);
  }
  if (params.has("difficulty") || params.has("cityDifficulty")) {
    setSelect("cityDifficulty", params.get("cityDifficulty") || params.get("difficulty"), ["familiar", "mixed", "chaos"]);
  }
  if (params.has("mapMode")) {
    setSelect("mapMode", params.get("mapMode"), ["hardcore", "outlines", "labels"]);
  }
  if (params.has("tone") || params.has("toneMode")) {
    setSelect("toneMode", params.get("toneMode") || params.get("tone"), ["lads", "friendly", "school"]);
  }
  if (params.has("scoring") || params.has("scoringMode")) {
    setSelect("scoringMode", params.get("scoringMode") || params.get("scoring"));
  }
  if (params.has("practice")) {
    const v = String(params.get("practice")).toLowerCase();
    setSelect("practiceRound", v === "1" || v === "on" || v === "true" ? "on" : "off", ["on", "off"]);
  }
  if (params.has("rounds") || params.has("roundCount")) {
    const raw = Number(params.get("rounds") ?? params.get("roundCount"));
    if (Number.isFinite(raw)) {
      const el = $("roundCount");
      if (el) el.value = String(clamp(Math.round(raw), 1, 20));
    }
  }
  if (params.has("timer") || params.has("roundDuration")) {
    const raw = Number(params.get("timer") ?? params.get("roundDuration"));
    if (Number.isFinite(raw)) {
      const el = $("roundDuration");
      if (el) {
        const target = String(clamp(Math.round(raw), 10, 60));
        if ([...el.options].some(opt => opt.value === target)) el.value = target;
      }
    }
  }
  if (params.has("name")) {
    const el = $("hostName");
    if (el && params.get("name")) el.value = String(params.get("name")).slice(0, 32);
  }
}

function autoStartSoloFromUrl() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("mode") !== "solo" && params.get("solo") !== "1") return;
  if (state.game) return;
  applySoloUrlOverrides(params);
  updateSetupSummary();
  setTimeout(() => {
    if (!state.game) createGame(true);
  }, 250);
}

autoStartSoloFromUrl();


$("joinAsNewPlayerBtn")?.addEventListener("click", () => {
  sessionStorage.setItem("pinThePlanetForceNewPlayer", "1");
  localStorage.removeItem("worldPinQuizSession");
  $("playerName")?.focus();
  toast("Enter a different name to join as a new player");
});


document.documentElement.dataset.ptpVersion = "v64-version-copy";
