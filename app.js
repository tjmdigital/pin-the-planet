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

const PTP_APP_VERSION = "v64-version-copy";
window.PTP_VERSION = PTP_APP_VERSION;

const isFirebaseConfigured = firebaseConfig.apiKey && firebaseConfig.apiKey !== "PASTE_HERE" && firebaseConfig.databaseURL;
let app = null;
let db = null;

if (isFirebaseConfigured) {
  app = initializeApp(firebaseConfig);
  db = getDatabase(app);
  document.getElementById("connectionStatus").textContent = "Online sync ready";
  probeFirebaseHealth();
} else {
  document.getElementById("connectionStatus").textContent = "Firebase needed";
  document.getElementById("firebaseWarning").classList.remove("hidden");
}

// Non-blocking probe: tries a tiny write+remove to verify the database rules
// actually allow the reads/writes the game needs. If the rules are misconfigured
// the app would otherwise silently fail to sync rooms - this surfaces it.
async function probeFirebaseHealth() {
  if (!db) return;
  // Probe under /games so the test exercises the same path the app actually uses.
  const probePath = `games/__probe__/${Math.random().toString(36).slice(2, 10)}_${Date.now()}`;
  try {
    await set(ref(db, probePath), { ts: Date.now() });
    await remove(ref(db, probePath));
  } catch (error) {
    const status = document.getElementById("connectionStatus");
    if (status) status.textContent = "Sync limited";
    const warning = document.getElementById("firebaseWarning");
    if (warning) {
      const heading = warning.querySelector("strong");
      const detail = warning.querySelector("p");
      if (heading) heading.textContent = "Realtime sync is not working.";
      if (detail) detail.textContent = "Room play may not work. Check Firebase rules or your network, then refresh.";
      warning.classList.remove("hidden");
    }
  }
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
  baseMapMode: null,
  gameUnsubscribe: null
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

function randomFrom(options, seed) {
  return options[Math.abs(Math.floor(seed || 0)) % options.length];
}

function verdictForDistance(distanceKm) {
  const tone = currentToneMode();
  if (!Number.isFinite(distanceKm)) {
    if (tone === "school") return "No guess this time. Try to make a sensible estimate next round.";
    if (tone === "friendly") return "No guess submitted this time.";
    return "No guess. Bottle job.";
  }

  if (tone === "school") {
    if (distanceKm < 75) return "Excellent work. That is a very accurate estimate.";
    if (distanceKm < 300) return "Very close. You clearly knew the right region.";
    if (distanceKm < 1000) return "Good effort. You were in the right broad area.";
    if (distanceKm < 3000) return "Not quite, but your guess gives you a useful clue for next time.";
    return "That was a long way off, but the reveal is a good chance to learn the location.";
  }

  if (tone === "friendly") {
    if (distanceKm < 75) return "Brilliant guess. Very nicely done.";
    if (distanceKm < 300) return "Strong effort. That was close.";
    if (distanceKm < 1000) return "Decent guess. Points on the board.";
    if (distanceKm < 3000) return "A brave guess. Not quite there.";
    return "A long way off, but at least you committed.";
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
      "Borderline forensic. Horrible stuff."
    ]},
    { max: 75, lines: [
      "Basically in the right pub.",
      "Annoyingly accurate.",
      "Very tidy. Nobody likes a swot.",
      "That one will be mentioned again later.",
      "Close enough to start acting unbearable.",
      "A properly sharp guess, unfortunately.",
      "Very strong. Sickening, really.",
      "That’s the kind of guess that ruins friendships."
    ]},
    { max: 200, lines: [
      "Very respectable. Horrible to admit.",
      "Close enough to pretend he knew it.",
      "Solid geography dad energy.",
      "He will now act like this was easy.",
      "Strong effort. Smugness incoming.",
      "You can dine out on that for at least a week.",
      "Very decent. Deeply irritating.",
      "Close enough for boastful retellings."
    ]},
    { max: 500, lines: [
      "Same general area. We’ll allow it.",
      "Not bad after three beers.",
      "Close-ish. Confidence did the work.",
      "Good enough to be irritating.",
      "A respectable lash at it.",
      "Plenty of guessers would have killed for that.",
      "Not perfect, but more than good enough.",
      "That’ll do nicely in a pub quiz."
    ]},
    { max: 1000, lines: [
      "Not awful, not clever.",
      "Geography GCSE muscle memory kicking in.",
      "Acceptable pub quiz guesswork.",
      "More luck than judgement, but points are points.",
      "A serviceable guess from a serviceable man.",
      "Decent enough. No medals, no shame.",
      "Competent, which feels almost suspicious.",
      "Close enough to avoid public ridicule."
    ]},
    { max: 2000, lines: [
      "Confidently adjacent to reality.",
      "Wrong, but in a thoughtful way.",
      "You’ll defend that for ten minutes.",
      "A near miss if you squint dramatically.",
      "Not right, but not fully embarrassing either.",
      "There was a shape to the logic. Sadly not much more.",
      "A respectable miss. Still a miss.",
      "You were circling the drain of correctness."
    ]},
    { max: 4000, lines: [
      "Same planet, at least.",
      "There was a theory. It was wrong.",
      "A brave interpretation of the question.",
      "Geography by vibes alone.",
      "You’ve mistaken confidence for accuracy.",
      "Somewhere between hopeful and clueless.",
      "Wrong enough to raise eyebrows.",
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
      "The pin is wandering about unsupervised."
    ]},
    { max: Infinity, lines: [
      "Wrong hemisphere. Tremendous work.",
      "Does he know what a city is?",
      "That guess needs a written apology.",
      "The map has been used mainly as decoration.",
      "At that point it’s less a guess, more a cry for help.",
      "You’ve gone so wrong it feels personal.",
      "That belongs in The Hague.",
      "An absolute war crime of a pin."
    ]}
  ];

  const band = bands.find(item => distanceKm < item.max);
  return randomFrom(band.lines, distanceKm);
}

function bestSpotlightCopy(distanceKm) {
  const tone = currentToneMode();
  if (tone === "school") return "Best estimate this round. Excellent use of map knowledge.";
  if (tone === "friendly") return "Best guess of the round. Nicely done.";
  if (!Number.isFinite(distanceKm)) return "No idea how he’s won that, but here we are.";
  if (distanceKm < 50) return randomFrom(["Absolutely obscene. Investigate immediately.", "That is elite behaviour. Sickening stuff.", "A monstrous guess. Everyone hates this."], distanceKm);
  if (distanceKm < 250) return randomFrom(["Very sharp. He’ll be unbearable about that.", "Excellent work, sadly.", "That’s properly good and deeply annoying."], distanceKm);
  if (distanceKm < 1000) return randomFrom(["Best of the lot. Pub-quiz royalty for one round.", "A decent bit of work in a sea of confusion.", "Strong enough to earn smug rights."], distanceKm);
  return randomFrom(["Not brilliant, but still enough to win this circus.", "Best of a scruffy bunch.", "He’s won, which says worrying things about the field."], distanceKm);
}

function worstSpotlightCopy(distanceKm) {
  const tone = currentToneMode();
  if (tone === "school") return "Most room for improvement this round. The reveal should help.";
  if (tone === "friendly") return "Tough one. There is always the next round.";
  if (!Number.isFinite(distanceKm)) return "Didn’t even submit. Bottle job of the round.";
  if (distanceKm < 1000) return randomFrom(["Harsh to roast this, but someone has to finish last.", "Unlucky. A decent guess in a stronger field.", "Not a disaster - just not good enough."], distanceKm);
  if (distanceKm < 4000) return randomFrom(["There was a method. Shame about the result.", "An imaginative pin with tragic consequences.", "Wrong in a way that felt avoidable."], distanceKm);
  return randomFrom(["Absolutely appalling. A landmark performance in being wrong.", "That pin should be confiscated.", "A generational stinker of a guess."], distanceKm);
}

function escapeHtml(input) {
  return String(input || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Same escaping rules as escapeHtml (covers quotes too) - aliased for readability
// at attribute boundaries.
const escapeAttr = escapeHtml;

function safeAvatar(player) {
  return escapeHtml(player?.avatar || "🌍");
}

function displayPlayerName(player) {
  if (isSoloGame?.() && player?.id === state.playerId) return "You";
  return player?.name || "Player";
}

function playerLabel(player) {
  return `${safeAvatar(player)} ${escapeHtml(displayPlayerName(player))}`;
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
  const roundsRequested = clamp(Number($("roundCount")?.value || 10), 1, 20);
  return {
    roundsRequested,
    roundDurationSeconds: clamp(Number($("roundDuration")?.value || ROUND_DURATION_SECONDS), 10, 60),
    practiceEnabled,
    questionType: $("questionType")?.value || "city",
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
  return state.game?.roundsRequested || Math.max(0, (state.game?.questions?.length || 0) - (state.game?.practiceEnabled ? 1 : 0));
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
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2100);
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
    if (!state.game.acceptingGuesses || state.game.revealed || !state.game.started) {
      toast("Wait for the host to start the round");
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
  toast("Guess submitted");
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
  const options = getSetupOptions();
  const questionCount = questionCountForOptions(options);

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
    avatar: randomAvatar(),
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
}

function subscribeToGame() {
  unsubscribeFromGame();
  const gameRef = ref(db, `games/${state.gameCode}`);
  state.gameUnsubscribe = onValue(gameRef, (snap) => {
    if (!snap.exists()) {
      toast("Room was removed");
      leaveGame(false);
      return;
    }
    state.game = snap.val();
    renderGame();
  });
}

function unsubscribeFromGame() {
  if (typeof state.gameUnsubscribe === "function") {
    try { state.gameUnsubscribe(); } catch (error) { /* ignore */ }
  }
  state.gameUnsubscribe = null;
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

// Players to include in a new round's eligibility set. Online players are always
// included; an offline player is included only if they were active very recently,
// which protects against a brief disconnect/reconnect flicker right at round
// start without dragging in stale ghosts from earlier sessions.
const ROUND_ELIGIBILITY_GRACE_MS = 60 * 1000;

function activeRoundPlayers() {
  const deduped = dedupePlayersForDisplay(playersArray());
  const now = Date.now();
  return deduped.filter(player => {
    if (player.online !== false) return true;
    const lastActive = Number(player.rejoinedAt) || Number(player.joinedAt) || 0;
    return lastActive > 0 && now - lastActive < ROUND_ELIGIBILITY_GRACE_MS;
  });
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
  const shouldCloseForAllGuessed = allPlayersHaveGuessed();
  const shouldCloseForTime = left === 0 || hasRoundTimerEnded();

  if (!shouldCloseForAllGuessed && !shouldCloseForTime) return;

  const key = currentRoundKey();
  if (state.autoClosingRoundKey === key) return;
  state.autoClosingRoundKey = key;

  await update(ref(db, `games/${state.gameCode}`), {
    acceptingGuesses: false,
    roundClosedAt: Date.now(),
    roundClosedReason: shouldCloseForAllGuessed ? "all-guessed" : "time-up"
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
      if (!guess || !question) return { player, hasGuess: false, distance: Infinity, points: 0, guess: null };
      const distance = haversineKm(guess.lat, guess.lng, question.lat, question.lng);
      const points = pointsForDistance(distance, true);
      return { player, hasGuess: true, distance, points, guess };
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
    $("roundState").textContent = `${displayLabel} - place your pin`;
    $("targetName").textContent = locationDisplayName(question) || "Finished";
    $("playerHint").textContent = isSolo ? "Click the map to place or change your pin before time runs out." : (state.isHost ? "Click the map to submit your own guess. The round closes automatically once everyone has guessed." : "Click anywhere on the map to submit or change your guess.");
    if (allIn || roundClosedByAll) {
      $("allGuessesBanner").textContent = isSolo ? "✅ Guess locked in - score when ready." : (state.isHost ? "✅ All guesses are in - reveal time." : "✅ All guesses are in - waiting for host.");
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
      <div class="score">${Number(player.total) || 0}</div>
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
    $("roundStatusMain").textContent = `${submitted}/${total} guessed`;
    $("roundStatusSub").textContent = state.isHost ? "The round is closed. Reveal the answer when ready." : "The round is closed. Waiting for the answer reveal.";
    return;
  }

  $("roundStatusPill").textContent = left === null ? "Live" : `${left}s left`;
  if (isSoloGame()) {
    $("roundStatusMain").textContent = submitted ? "Guess locked in" : "Place your guess";
    $("roundStatusSub").textContent = submitted ? "You can move your pin until time runs out." : "Drop one pin before the timer ends.";
  } else {
    $("roundStatusMain").textContent = `${submitted}/${total} guessed`;
    $("roundStatusSub").textContent = submitted === total
      ? (state.isHost ? "Everyone is in. Reveal the answer." : "Everyone is in. Waiting for the answer reveal.")
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
    const verdict = row?.hasGuess ? verdictForDistance(row.distance) : "No guess submitted. Bottle job.";
    const html = `
      <div class="result solo-result-card">
        <div class="solo-result-top">
          <div>
            <strong>${row?.player ? playerLabel(row.player) : "You"}</strong>
            <p class="small muted">${row?.hasGuess ? `${Math.round(row.distance).toLocaleString()} km away` : "No guess submitted"}</p>
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
          <p class="small muted">${row.hasGuess ? `${Math.round(row.distance).toLocaleString()} km away - ${verdictForDistance(row.distance)}` : "No guess submitted - Bottle job."}</p>
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
  const isBestYou = best.player.id === state.playerId;
  const isWorstYou = worst.player.id === state.playerId && worst.player.id !== best.player.id;

  const bestHtml = `
    <div class="round-spotlight-card best ${isBestYou ? "is-you" : ""}">
      <div class="round-spotlight-kicker">🏆 Best guess ${isBestYou ? '<span class="spotlight-you-pill">You</span>' : ""}</div>
      <div class="round-spotlight-head">
        <div class="round-spotlight-avatar">${safeAvatar(best.player)}</div>
        <div>
          <div class="round-spotlight-name">${escapeHtml(best.player.name)}</div>
          <div class="round-spotlight-meta">${Math.round(best.distance).toLocaleString()} km away</div>
        </div>
        <div class="round-spotlight-points">+${best.points || 0}</div>
      </div>
      <div class="round-spotlight-verdict">${escapeHtml(bestSpotlightCopy(best.distance))}</div>
    </div>
  `;

  let worstHtml = "";
  if (worst && worst.player.id !== best.player.id) {
    worstHtml = `
      <div class="round-spotlight-card worst ${isWorstYou ? "is-you" : ""}">
        <div class="round-spotlight-kicker">🥄 Roast of the round ${isWorstYou ? '<span class="spotlight-you-pill">You</span>' : ""}</div>
        <div class="round-spotlight-head">
          <div class="round-spotlight-avatar">${safeAvatar(worst.player)}</div>
          <div>
            <div class="round-spotlight-name">${escapeHtml(worst.player.name)}</div>
            <div class="round-spotlight-meta">${Math.round(worst.distance).toLocaleString()} km away</div>
          </div>
          <div class="round-spotlight-points">+${worst.points || 0}</div>
        </div>
        <div class="round-spotlight-verdict">${escapeHtml(worstSpotlightCopy(worst.distance))}</div>
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
    setup_key: isSoloGame() ? soloSetupKey(state.game) : undefined,
    is_solo: isSoloGame()
  });
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
  const byTotal = playersArray().sort((a, b) => (b.total || 0) - (a.total || 0));
  const showPubPoints = state.game.scoringMode === "pub";
  const isSolo = isSoloGame();

  const soloScore = Number(byTotal[0]?.total) || 0;
  const soloPercent = scorePercent(soloScore, state.game);
  const soloBestResult = isSolo ? recordSoloResultIfNeeded() : null;
  const soloBest = isSolo ? getSoloBest(state.game) : null;
  const bestScore = soloBest?.bestScore || soloScore;
  const bestPercent = soloBest?.bestPercent || soloPercent;
  const isNewBest = Boolean(soloBestResult?.isNewBest);

  const html = isSolo ? `
    <div class="final-board solo-final-board">
      <div class="final-board-header">
        <div class="final-board-kicker">${isNewBest ? "🏆 New best run" : "🎯 Solo run complete"}</div>
        <div class="final-board-title">${soloScore.toLocaleString()}</div>
        <div class="final-board-subtitle">${soloPercent}% of the maximum score for this ${soloSetupLabel(state.game)}.</div>
      </div>
      <div class="final-board-list final-board-list-solo">
        <div class="final-board-row champion solo">
          <div class="final-place">${safeAvatar(byTotal[0])}</div>
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
                <div class="final-total">${Number(player.total) || 0}</div>
                <div class="final-round-add">${isPracticeRound() ? "practice only" : `+${Number(roundPointsByPlayer[player.id]) || 0} this round`}</div>
              </div>
            </div>
          `;
        }).join("")}
      </div>
      <div class="final-board-actions">
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
  const byTotal = playersArray().sort((a, b) => (b.total || 0) - (a.total || 0));
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
            ${state.game.revealed ? `<span class="small round-score">${isPracticeRound() ? "practice only" : `+${Number(roundPointsByPlayer[player.id]) || 0} this round`}</span>` : `<span class="small muted">${isSolo ? "Round live" : "Waiting for reveal"}</span>`}
          </div>
          <div class="score">${Number(player.total) || 0}</div>
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

  let html = `<div class="result"><strong>🏆 Round awards</strong>`;
  html += `<p class="small muted">Closest: ${playerLabel(best.player)} - ${Math.round(best.distance).toLocaleString()} km away.</p>`;
  if (worst && worst.player.id !== best.player.id) {
    html += `<p class="small muted">Wooden spoon: ${playerLabel(worst.player)} - ${Math.round(worst.distance).toLocaleString()} km away.</p>`;
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
        <div class="${classes.join(" ")}" title="${escapeAttr(row.player.name)}">${safeAvatar(row.player)}</div>
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

  const verdict = row.hasGuess ? verdictForDistance(row.distance) : "No guess submitted. Bottle job.";

  card.classList.remove("hidden");
  const html = `
    <div class="personal-result-inner">
      <div class="personal-result-emoji">${safeAvatar(row.player)}</div>
      <div>
        <div class="personal-result-title">${isSoloGame() ? "Your round score" : "Your round result"}</div>
        <div class="personal-result-meta">${row.hasGuess ? `${Math.round(row.distance).toLocaleString()} km away` : "No guess submitted"}</div>
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
  state.guessLines.forEach(line => line.remove());
  state.revealMarkers.forEach(marker => marker.remove());
  state.guessLines = [];
  state.revealMarkers = [];

  if (state.game.revealed && question) {
    state.answerMarker = L.marker([question.lat, question.lng], { icon: markerIcons.answer, zIndexOffset: 900 })
      .bindPopup(`<strong>Answer:</strong> ${escapeHtml(locationDisplayName(question))}`)
      .addTo(state.map);

    const rows = roundRows().filter(row => row.hasGuess);
    const rowsByDistance = roundRowsByDistance(rows);
    const worstRow = rowsByDistance.length ? rowsByDistance[rowsByDistance.length - 1] : null;

    rows.forEach((row) => {
      const distanceRank = Math.max(0, rowsByDistance.findIndex(distanceRow => distanceRow.player.id === row.player.id));
      const wrappedGuess = wrappedGuessForAnswer(row.guess, question);

      const marker = L.marker([wrappedGuess.lat, wrappedGuess.lng], {
        icon: playerEmojiIcon(row, distanceRank, worstRow?.player?.id),
        zIndexOffset: 700 + (rows.length - distanceRank)
      })
        .bindPopup(`<strong>${escapeHtml(row.player.name)}</strong><br>+${row.points} · ${Math.round(row.distance).toLocaleString()} km`)
        .addTo(state.map);

      state.revealMarkers.push(marker);

      const line = L.polyline([[wrappedGuess.lat, wrappedGuess.lng], [question.lat, question.lng]], {
        weight: 3,
        opacity: 0.62,
        noClip: true
      }).addTo(state.map);

      state.guessLines.push(line);
    });

    const points = [[question.lat, question.lng], ...rows.map(row => {
      const wrappedGuess = wrappedGuessForAnswer(row.guess, question);
      return [wrappedGuess.lat, wrappedGuess.lng];
    })];

    if (points.length > 1) {
      const bounds = L.latLngBounds(points);
      state.map.fitBounds(bounds.pad(0.32), { animate: true, duration: 0.55, maxZoom: 5 });
    }
  }
}

async function startRound() {
  const durationMs = (state.game?.roundDurationSeconds || ROUND_DURATION_SECONDS) * 1000;
  const now = Date.now();
  const roundPlayerIds = Object.fromEntries(activeRoundPlayers().map(player => [player.id, true]));

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
    const distance = guess ? haversineKm(guess.lat, guess.lng, question.lat, question.lng) : Infinity;
    const points = guess ? pointsForDistance(distance, true) : 0;
    if (!isPracticeRound()) {
      playerUpdates[`players/${player.id}/total`] = (Number(player.total) || 0) + points;
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
  const roundPlayerIds = Object.fromEntries(activeRoundPlayers().map(player => [player.id, true]));

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

  unsubscribeFromGame();

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

  const rounds = Number(game.roundsRequested) || scoredRoundTotal() || Number(game.questions?.length) || 10;
  const difficulty = ["familiar", "mixed", "chaos"].includes(game.cityDifficulty) ? game.cityDifficulty : "mixed";
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

function ordinal(rank) {
  if (rank === 1) return "1st";
  if (rank === 2) return "2nd";
  if (rank === 3) return "3rd";
  return `${rank}th`;
}

function buildResultsText() {
  const rows = typeof finalSortedPlayers === "function" ? finalSortedPlayers() : playersArray().sort((a, b) => (b.total || 0) - (a.total || 0));
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
    const bestQuestion = typeof locationDisplayName === "function" ? locationDisplayName(best.question || currentQuestion()) : (best.question?.name || currentQuestion()?.name || "the answer");
    lines.push("");
    lines.push(`Best pin: ${best.player.name} was ${Math.round(best.distance).toLocaleString()}km from ${bestQuestion}.`);

    if (worst && worst.player.id !== best.player.id) {
      const worstQuestion = typeof locationDisplayName === "function" ? locationDisplayName(worst.question || currentQuestion()) : (worst.question?.name || currentQuestion()?.name || "the answer");
      lines.push(`Worst pin: ${worst.player.name} was ${Math.round(worst.distance).toLocaleString()}km from ${worstQuestion}.`);
    }

    if (currentRows.length > 1 && Number.isFinite(worst.distance)) {
      const spread = Math.round((worst.distance - best.distance)).toLocaleString();
      lines.push(`Most divisive: ${spread}km between best and worst.`);
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

function updateSetupSummary() {
  const title = $("setupSummaryTitle");
  const text = $("setupSummaryText");
  const duration = $("setupDurationPill");
  if (!title || !text) return;

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
  text.textContent = `${rounds} ${rounds === 1 ? "round" : "rounds"} of ${questionType.toLowerCase()}, ${timer.toLowerCase()} per round${practice ? ", plus a practice round first" : ""}. Expect ${difficultySummary}, ${mapSummary}, ${toneSummary}, and ${scoringSummary}.${timerWarning}`;
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

["roundCount", "roundDuration", "practiceRound", "questionType", "cityDifficulty", "mapMode", "toneMode", "scoringMode"].forEach((id) => {
  $(id)?.addEventListener("input", updateSetupSummary);
  $(id)?.addEventListener("change", () => {
    updateSetupSummary();
    if (typeof getSetupOptions === "function" && typeof warmCityPool === "function" && typeof questionCountForOptions === "function") {
      const options = getSetupOptions();
      warmCityPool(questionCountForOptions(options), options).catch(() => {});
    }
  });
});

updateSetupSummary();

$("createGameBtn").addEventListener("click", () => createGame(false));
$("playSoloBtn").addEventListener("click", () => createGame(true));
["roundCount", "practiceRound", "questionType", "cityDifficulty"].forEach(id => {
  $(id)?.addEventListener("change", () => {
    const options = getSetupOptions();
    warmCityPool(questionCountForOptions(options), options).catch(() => {});
  });
});
warmCityPool(questionCountForOptions(getSetupOptions()), getSetupOptions()).catch(() => {});
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
  if (target.id === "finalNewGameBtn") newGameSamePlayers();
  if (target.id === "finalHostOwnBtn") hostOwnGroup();
});


/* mobile gesture hardening - prevent pinch-zoom while the map is in play */
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
      events: events.slice(-10),
      soloBestKeys: Object.keys(soloBests)
    }, null, 2))}</pre>
  `;

  document.getElementById("debugCloseBtn")?.addEventListener("click", () => panel.remove());
}

setInterval(renderDebugPanel, 1500);


function autoStartSoloFromUrl() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("mode") !== "solo" && params.get("solo") !== "1") return;
  if (state.game) return;
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
