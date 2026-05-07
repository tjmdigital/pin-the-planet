// Pin the Planet question API
// Contract:
// - familiar: server-side familiar pool only
// - mixed: server-side familiar + mixed-extras pools combined
// - chaos: server-side chaos pool only
// Live Wikidata is NOT called during room creation. Wikidata may be
// used out-of-band to refresh the JSON pools in /data, but never live.
// Normal city question requests must never 500.

const fs = require("fs");
const path = require("path");

const familiarPool = require("../data/cities.familiar.json");
const mixedExtrasPool = require("../data/cities.mixed.json");
const chaosPool = require("../data/cities.chaos.json");
const groundsUkPool = require("../data/grounds-uk.json");

// Geometry datasets are loaded lazily on first request so city-only
// requests don't pay the JSON.parse cost.
let countryFeaturesCache = null;
let countyUkCache = null;
let stateUsCache = null;

function loadGeoFeatures(filename, cacheRef) {
  if (cacheRef.value) return cacheRef.value;
  const file = path.join(__dirname, "..", "data", filename);
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  cacheRef.value = (data.features || []).filter(f => f && f.properties && f.geometry);
  return cacheRef.value;
}
function loadCountryFeatures() {
  const ref = { value: countryFeaturesCache };
  const result = loadGeoFeatures("countries.geojson", ref);
  countryFeaturesCache = ref.value;
  return result;
}
function loadCountyUkFeatures() {
  const ref = { value: countyUkCache };
  const result = loadGeoFeatures("counties-uk.geojson", ref);
  countyUkCache = ref.value;
  return result;
}
function loadStateUsFeatures() {
  const ref = { value: stateUsCache };
  const result = loadGeoFeatures("states-us.geojson", ref);
  stateUsCache = ref.value;
  return result;
}

const API_VERSION = "v95-uk-grounds";

const UK_US_COUNTRIES = new Set(["United Kingdom", "United States"]);
const FAMILIAR_COUNTRIES = new Set([
  "United Kingdom","United States","Ireland","Canada","Australia","New Zealand",
  "France","Germany","Italy","Spain","Netherlands","Portugal","Greece","Sweden",
  "Norway","Denmark","Belgium","Switzerland","Austria","Czechia","Poland",
  "Hungary","Finland","Iceland","South Africa","Japan","Mexico","Brazil",
  "Turkey","Egypt","South Korea","Argentina","Chile","Colombia","Peru"
]);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function shuffleCopy(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function uniqueCityPool(cities) {
  const seen = new Set();
  const output = [];
  for (const city of cities) {
    const key = `${city.name}|${Number(city.lat).toFixed(3)}|${Number(city.lng).toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(city);
  }
  return output;
}

function groupCitiesByCountry(cities) {
  return cities.reduce((groups, city) => {
    if (!groups.has(city.country)) groups.set(city.country, []);
    groups.get(city.country).push(city);
    return groups;
  }, new Map());
}

function pickOneCityPerCountry(cities, count, options = {}) {
  const pool = uniqueCityPool(cities);
  const groups = groupCitiesByCountry(pool);
  const target = clamp(Number(count || 10), 1, 25);
  const seedFamiliar = options.seedFamiliar !== false;
  const chosenCountries = [];
  const chosen = [];

  const addCountry = (country) => {
    if (!groups.has(country) || chosenCountries.includes(country) || chosen.length >= target) return;
    chosenCountries.push(country);
    chosen.push(shuffleCopy(groups.get(country))[0]);
  };

  if (seedFamiliar && target >= 3) {
    const ukUsAvailable = shuffleCopy([...UK_US_COUNTRIES]).filter(country => groups.has(country));
    if (ukUsAvailable.length) addCountry(ukUsAvailable[0]);
  }

  if (seedFamiliar && target >= 6) {
    const familiarAvailable = shuffleCopy([...FAMILIAR_COUNTRIES])
      .filter(country => groups.has(country) && !UK_US_COUNTRIES.has(country));
    if (familiarAvailable.length) addCountry(familiarAvailable[0]);
  }

  shuffleCopy([...groups.keys()])
    .filter(country => !chosenCountries.includes(country))
    .forEach(addCountry);

  if (chosen.length < target) {
    const usedKeys = new Set(chosen.map(city => `${city.name}|${city.lat}|${city.lng}`));
    for (const city of shuffleCopy(pool)) {
      if (chosen.length >= target) break;
      const key = `${city.name}|${city.lat}|${city.lng}`;
      if (usedKeys.has(key)) continue;
      usedKeys.add(key);
      chosen.push(city);
    }
  }

  // Last-resort: never throw. Allow repeats so we can satisfy the requested count.
  while (chosen.length < target && pool.length > 0) {
    chosen.push(shuffleCopy(pool)[0]);
  }

  return chosen.slice(0, target);
}

function poolForDifficulty(difficulty) {
  if (difficulty === "familiar") {
    return { cities: uniqueCityPool(familiarPool), poolName: "familiar", seedFamiliar: true };
  }
  if (difficulty === "mixed") {
    return {
      cities: uniqueCityPool([...familiarPool, ...mixedExtrasPool]),
      poolName: "mixed",
      seedFamiliar: true
    };
  }
  return { cities: uniqueCityPool(chaosPool), poolName: "chaos", seedFamiliar: false };
}

function buildQuestions(count, options, debug) {
  const target = clamp(Number(count || 10), 1, 25);
  const difficulty = String(options.cityDifficulty || "mixed").toLowerCase();
  const { cities, poolName, seedFamiliar } = poolForDifficulty(difficulty);
  const uniqueCountries = new Set(cities.map(c => c.country)).size;

  debug.questionType = "city";
  debug.resolvedDifficulty = difficulty;
  debug.pool = sourceFor(difficulty);
  debug.poolName = poolName;
  debug.poolSize = cities.length;
  debug.uniqueCountries = uniqueCountries;
  debug.liveWikidataAttempted = false;
  debug.geometryIncluded = false;
  debug.mode = difficulty;
  debug.requestedCount = target;

  return pickOneCityPerCountry(cities, target, { seedFamiliar });
}

function sourceFor(difficulty) {
  if (difficulty === "familiar") return "familiar-pool";
  if (difficulty === "chaos") return "chaos-pool";
  return "mixed-pool";
}

// --- Daily challenge --------------------------------------------------
// Same questions for every player on the same UTC day. Determinism is
// achieved with a date-seeded PRNG, so no server state is required.
//
// Why mulberry32: tiny, fast, well-distributed for our small pools.
function mulberry32(seed) {
  let s = seed | 0;
  return function next() {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle(items, seed) {
  const rng = mulberry32(seed);
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function todayUtcDate() {
  // ISO YYYY-MM-DD in UTC. Independent of server timezone settings.
  return new Date().toISOString().slice(0, 10);
}

function dateSeed(dateStr) {
  // "2026-05-04" -> 20260504. Always positive, fits in 32-bit int.
  return parseInt(String(dateStr).replace(/-/g, ""), 10);
}

// 4 + 4 = 8 rounds ~ 4 minutes at 30s per round, comfortable for a
// daily quick-fire format. Was 10 originally; trimmed for pace.
const DAILY_CITY_COUNT = 4;
const DAILY_COUNTRY_COUNT = 4;

function buildDailyQuestions(debug) {
  const dailyDate = todayUtcDate();
  const seed = dateSeed(dailyDate);

  // City pool: combined familiar + mixed extras, deduped.
  const cityPool = uniqueCityPool([...familiarPool, ...mixedExtrasPool]);
  const cityPicks = seededShuffle(cityPool, seed).slice(0, DAILY_CITY_COUNT);
  const cityQuestions = cityPicks.map((c) => ({
    type: "city",
    name: c.name,
    displayName: c.displayName,
    sourceName: c.sourceName,
    country: c.country,
    lat: c.lat,
    lng: c.lng,
    tier: c.tier
  }));

  // Country pool: mainland-trimmed countries with valid label points + geometry.
  const countryFeatures = loadCountryFeatures().filter(f => {
    const lat = f.properties.labelLat;
    const lng = f.properties.labelLng;
    return Number.isFinite(lat) && Number.isFinite(lng) && f.geometry;
  });
  const countryPicks = seededShuffle(countryFeatures, seed + 1).slice(0, DAILY_COUNTRY_COUNT);
  const countryQuestions = countryPicks.map((f) => ({
    id: f.properties.iso || f.properties.iso3 || f.properties.name,
    type: "country",
    name: f.properties.name,
    displayName: f.properties.displayName || f.properties.name,
    sourceName: f.properties.name,
    country: f.properties.name,
    iso: f.properties.iso || "",
    iso3: f.properties.iso3 || "",
    continent: f.properties.continent || "",
    lat: f.properties.labelLat,
    lng: f.properties.labelLng,
    geometry: f.geometry
  }));

  // Interleave the two by shuffling the combined pack with a different
  // seed offset, so player 1 in Sydney sees the same order as player 2
  // in San Francisco for the same UTC day.
  const combined = seededShuffle([...cityQuestions, ...countryQuestions], seed + 2);

  debug.questionType = "daily";
  debug.resolvedDifficulty = "daily";
  debug.pool = "daily-pool";
  debug.poolName = "daily";
  debug.poolSize = cityPool.length + countryFeatures.length;
  debug.cityCount = cityQuestions.length;
  debug.countryCount = countryQuestions.length;
  debug.uniqueCountries = new Set(combined.map(q => q.country)).size;
  debug.liveWikidataAttempted = false;
  debug.geometryIncluded = true;
  debug.mode = "daily";
  debug.requestedCount = combined.length;
  debug.dailyDate = dailyDate;

  return { questions: combined, dailyDate };
}

function buildCountryQuestions(count, debug) {
  const target = clamp(Number(count || 10), 1, 25);
  const features = loadCountryFeatures();
  const playable = features.filter(f => {
    const lat = f.properties.labelLat;
    const lng = f.properties.labelLng;
    return Number.isFinite(lat) && Number.isFinite(lng) && f.geometry;
  });

  debug.questionType = "country";
  debug.resolvedDifficulty = "country";
  debug.pool = "country-pool";
  debug.poolName = "country";
  debug.poolSize = playable.length;
  debug.countryCount = playable.length;
  debug.uniqueCountries = playable.length;
  debug.liveWikidataAttempted = false;
  debug.mode = "country";
  debug.requestedCount = target;
  debug.geometryIncluded = true;

  const shuffled = shuffleCopy(playable);
  const picks = shuffled.slice(0, target);

  // If we somehow have fewer than count, allow repeats so we never throw.
  while (picks.length < target && shuffled.length > 0) {
    picks.push(shuffled[picks.length % shuffled.length]);
  }

  return picks.map((f) => ({
    id: f.properties.iso || f.properties.iso3 || f.properties.name,
    type: "country",
    name: f.properties.name,
    displayName: f.properties.displayName || f.properties.name,
    sourceName: f.properties.name,
    country: f.properties.name,
    iso: f.properties.iso || "",
    iso3: f.properties.iso3 || "",
    continent: f.properties.continent || "",
    lat: f.properties.labelLat,
    lng: f.properties.labelLng,
    geometry: f.geometry
  }));
}

// Same shape as buildCountryQuestions but for sub-national polygon
// packs (UK ceremonial counties, US states). Each pack shares the
// same scoring logic on the client because every question carries
// its own geometry and label point.
function buildSubNationalQuestions(count, debug, opts) {
  const target = clamp(Number(count || 10), 1, 25);
  const features = opts.loader();
  const playable = features.filter(f => {
    const lat = f.properties.labelLat;
    const lng = f.properties.labelLng;
    return Number.isFinite(lat) && Number.isFinite(lng) && f.geometry;
  });

  debug.questionType = opts.type;
  debug.resolvedDifficulty = opts.type;
  debug.pool = opts.poolName;
  debug.poolName = opts.poolName;
  debug.poolSize = playable.length;
  debug.countryCount = playable.length;
  debug.uniqueCountries = playable.length;
  debug.liveWikidataAttempted = false;
  debug.mode = opts.type;
  debug.requestedCount = target;
  debug.geometryIncluded = true;

  const shuffled = shuffleCopy(playable);
  const picks = shuffled.slice(0, target);
  while (picks.length < target && shuffled.length > 0) {
    picks.push(shuffled[picks.length % shuffled.length]);
  }

  return picks.map((f) => ({
    id: f.properties.iso || f.properties.name,
    type: opts.type,
    name: f.properties.name,
    displayName: f.properties.displayName || f.properties.name,
    sourceName: f.properties.name,
    country: f.properties.country || opts.parentCountry,
    iso: f.properties.iso || "",
    stateCode: f.properties.stateCode || "",
    lat: f.properties.labelLat,
    lng: f.properties.labelLng,
    geometry: f.geometry
  }));
}

// UK football grounds: point-based pack, scored on distance to the
// stadium coordinate. Same shape as a city question so the existing
// scoring + reveal pipeline works unchanged - the client just uses a
// tighter distance decay because every ground sits inside the UK.
function buildGroundUkQuestions(count, debug) {
  const target = clamp(Number(count || 10), 1, 25);
  const pool = groundsUkPool.filter(g => Number.isFinite(g.lat) && Number.isFinite(g.lng));

  debug.questionType = "ground-uk";
  debug.resolvedDifficulty = "ground-uk";
  debug.pool = "ground-uk-pool";
  debug.poolName = "ground-uk";
  debug.poolSize = pool.length;
  debug.uniqueCountries = 1;
  debug.liveWikidataAttempted = false;
  debug.geometryIncluded = false;
  debug.mode = "ground-uk";
  debug.requestedCount = target;

  const shuffled = shuffleCopy(pool);
  const picks = shuffled.slice(0, target);
  while (picks.length < target && shuffled.length > 0) {
    picks.push(shuffled[picks.length % shuffled.length]);
  }

  return picks.map((g) => ({
    id: `ground:${g.club}`,
    type: "ground-uk",
    name: g.name,
    displayName: g.displayName || g.name,
    sourceName: g.ground || g.name,
    club: g.club,
    ground: g.ground,
    league: g.league,
    city: g.city,
    country: "United Kingdom",
    lat: g.lat,
    lng: g.lng
  }));
}

function makeQuestionPayload(req) {
  // Daily-challenge short-circuit. Ignores other params; questions are
  // entirely determined by today's UTC date.
  const dailyRequested = String(req.query.daily || req.query.mode || "").toLowerCase();
  if (dailyRequested === "1" || dailyRequested === "true" || dailyRequested === "daily") {
    const debug = {};
    const { questions, dailyDate } = buildDailyQuestions(debug);
    return {
      apiVersion: API_VERSION,
      generatedAt: new Date().toISOString(),
      count: questions.length,
      questionType: "daily",
      difficulty: "daily",
      mode: "daily",
      source: "daily-pool",
      dailyDate,
      debug,
      questions
    };
  }

  const rawDifficulty = String(req.query.cityDifficulty || req.query.difficulty || "mixed").toLowerCase();
  const difficulty = ["familiar", "mixed", "chaos"].includes(rawDifficulty) ? rawDifficulty : "mixed";
  const count = clamp(Number(req.query.count || 10), 1, 25);
  const rawType = String(req.query.questionType || "city").toLowerCase();
  const KNOWN_TYPES = new Set(["city", "country", "county-uk", "state-us", "ground-uk"]);
  const questionType = KNOWN_TYPES.has(rawType) ? rawType : "city";
  const options = {
    questionType,
    cityDifficulty: difficulty,
    practiceEnabled: String(req.query.practiceEnabled || "false") === "true",
    mapMode: String(req.query.mapMode || "hardcore"),
    scoringMode: String(req.query.scoringMode || "distance")
  };
  const debug = {};
  if (rawType && rawType !== questionType) debug.questionTypeForcedToCity = true;

  if (questionType === "country") {
    const questions = buildCountryQuestions(count, debug);
    debug.requestedCityDifficulty = difficulty;
    return {
      apiVersion: API_VERSION,
      generatedAt: new Date().toISOString(),
      count: questions.length,
      questionType: "country",
      difficulty: "country",
      mode: "country",
      source: "country-pool",
      debug,
      questions
    };
  }

  if (questionType === "county-uk") {
    const questions = buildSubNationalQuestions(count, debug, {
      type: "county-uk",
      poolName: "county-uk-pool",
      loader: loadCountyUkFeatures,
      parentCountry: "United Kingdom"
    });
    debug.requestedCityDifficulty = difficulty;
    return {
      apiVersion: API_VERSION,
      generatedAt: new Date().toISOString(),
      count: questions.length,
      questionType: "county-uk",
      difficulty: "county-uk",
      mode: "county-uk",
      source: "county-uk-pool",
      debug,
      questions
    };
  }

  if (questionType === "state-us") {
    const questions = buildSubNationalQuestions(count, debug, {
      type: "state-us",
      poolName: "state-us-pool",
      loader: loadStateUsFeatures,
      parentCountry: "United States"
    });
    debug.requestedCityDifficulty = difficulty;
    return {
      apiVersion: API_VERSION,
      generatedAt: new Date().toISOString(),
      count: questions.length,
      questionType: "state-us",
      difficulty: "state-us",
      mode: "state-us",
      source: "state-us-pool",
      debug,
      questions
    };
  }

  if (questionType === "ground-uk") {
    const questions = buildGroundUkQuestions(count, debug);
    debug.requestedCityDifficulty = difficulty;
    return {
      apiVersion: API_VERSION,
      generatedAt: new Date().toISOString(),
      count: questions.length,
      questionType: "ground-uk",
      difficulty: "ground-uk",
      mode: "ground-uk",
      source: "ground-uk-pool",
      debug,
      questions
    };
  }

  const questions = buildQuestions(count, options, debug);
  return {
    apiVersion: API_VERSION,
    generatedAt: new Date().toISOString(),
    count: questions.length,
    questionType: "city",
    difficulty,
    mode: "city",
    source: sourceFor(difficulty),
    debug,
    questions
  };
}

module.exports = async function handler(req, res) {
  try {
    const payload = makeQuestionPayload(req);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(payload);
  } catch (error) {
    // Static-pool emergency fallback: pick straight from the familiar pool
    // so we never return 500 for a normal request.
    try {
      const count = clamp(Number(req.query.count || 10), 1, 25);
      const difficulty = String(req.query.cityDifficulty || req.query.difficulty || "mixed").toLowerCase();
      const fallbackCities = uniqueCityPool(familiarPool);
      const questions = pickOneCityPerCountry(fallbackCities, count, { seedFamiliar: true });
      return res.status(200).json({
        apiVersion: API_VERSION,
        generatedAt: new Date().toISOString(),
        count: questions.length,
        questionType: "city",
        difficulty,
        mode: "city",
        source: "emergency-familiar-pool",
        debug: {
          questionType: "city",
          resolvedDifficulty: difficulty,
          pool: "emergency-familiar-pool",
          poolName: "familiar",
          poolSize: fallbackCities.length,
          uniqueCountries: new Set(fallbackCities.map(c => c.country)).size,
          liveWikidataAttempted: false,
          geometryIncluded: false,
          emergencyFallback: true,
          error: error?.message || String(error)
        },
        questions
      });
    } catch (fallbackError) {
      return res.status(500).json({
        error: "Question generation failed",
        message: fallbackError?.message || error?.message || String(error)
      });
    }
  }
};
