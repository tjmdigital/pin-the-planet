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

// Country geometries are loaded lazily on first country-mode request so
// city-only requests don't pay the JSON.parse cost.
let countryFeaturesCache = null;
function loadCountryFeatures() {
  if (countryFeaturesCache) return countryFeaturesCache;
  const file = path.join(__dirname, "..", "data", "countries.geojson");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  countryFeaturesCache = (data.features || []).filter(f => f && f.properties && f.geometry);
  return countryFeaturesCache;
}

const API_VERSION = "v68-question-api";

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

function makeQuestionPayload(req) {
  const rawDifficulty = String(req.query.cityDifficulty || req.query.difficulty || "mixed").toLowerCase();
  const difficulty = ["familiar", "mixed", "chaos"].includes(rawDifficulty) ? rawDifficulty : "mixed";
  const count = clamp(Number(req.query.count || 10), 1, 25);
  const rawType = String(req.query.questionType || "city").toLowerCase();
  const questionType = rawType === "country" ? "country" : "city";
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
