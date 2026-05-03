// Pin the Planet question API
// Contract:
// - familiar: server-side familiar pool only
// - mixed: server-side familiar + mixed-extras pools combined
// - chaos: server-side chaos pool only
// Live Wikidata is NOT called during room creation. Wikidata may be
// used out-of-band to refresh the JSON pools in /data, but never live.
// Normal city question requests must never 500.

const familiarPool = require("../data/cities.familiar.json");
const mixedExtrasPool = require("../data/cities.mixed.json");
const chaosPool = require("../data/cities.chaos.json");

const API_VERSION = "v66-question-api";

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

  debug.pool = poolName;
  debug.poolSize = cities.length;
  debug.uniqueCountries = uniqueCountries;
  debug.liveWikidataAttempted = false;
  debug.mode = difficulty;
  debug.requestedCount = target;

  return pickOneCityPerCountry(cities, target, { seedFamiliar });
}

function sourceFor(difficulty) {
  if (difficulty === "familiar") return "familiar-pool";
  if (difficulty === "chaos") return "chaos-pool";
  return "mixed-pool";
}

function makeQuestionPayload(req) {
  const rawDifficulty = String(req.query.cityDifficulty || req.query.difficulty || "mixed").toLowerCase();
  const difficulty = ["familiar", "mixed", "chaos"].includes(rawDifficulty) ? rawDifficulty : "mixed";
  const count = clamp(Number(req.query.count || 10), 1, 25);
  const options = {
    questionType: String(req.query.questionType || "city"),
    cityDifficulty: difficulty,
    practiceEnabled: String(req.query.practiceEnabled || "false") === "true",
    mapMode: String(req.query.mapMode || "hardcore"),
    scoringMode: String(req.query.scoringMode || "distance")
  };
  const debug = {};

  if (options.questionType !== "city") {
    options.questionType = "city";
    debug.questionTypeForcedToCity = true;
  }

  const questions = buildQuestions(count, options, debug);

  return {
    apiVersion: API_VERSION,
    generatedAt: new Date().toISOString(),
    count: questions.length,
    difficulty,
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
        difficulty,
        source: "emergency-familiar-pool",
        debug: {
          pool: "familiar",
          poolSize: fallbackCities.length,
          uniqueCountries: new Set(fallbackCities.map(c => c.country)).size,
          liveWikidataAttempted: false,
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
