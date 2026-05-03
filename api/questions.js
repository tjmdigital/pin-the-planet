// Pin the Planet question API
// Contract:
// - familiar: curated only, no Wikidata
// - mixed: curated + optional Wikidata wildcard
// - chaos: Wikidata-led with curated fallback
// Normal room creation should never 500 for city questions.

const API_VERSION = "v65-question-api";
const CITY_LOOKUP_ENDPOINT = "https://query.wikidata.org/sparql";

const FAMILIAR_COUNTRY_QIDS = [
  "Q145","Q30","Q27","Q16","Q408","Q664","Q142","Q183","Q38","Q29",
  "Q55","Q45","Q41","Q34","Q20","Q35","Q31","Q39","Q40","Q213",
  "Q36","Q28","Q33","Q189","Q258","Q17","Q96","Q155","Q43","Q79",
  "Q884","Q414","Q298","Q739","Q419"
];

const UK_US_COUNTRIES = new Set(["United Kingdom", "United States"]);
const FAMILIAR_COUNTRIES = new Set([
  "United Kingdom","United States","Ireland","Canada","Australia","New Zealand",
  "France","Germany","Italy","Spain","Netherlands","Portugal","Greece","Sweden",
  "Norway","Denmark","Belgium","Switzerland","Austria","Czechia","Poland",
  "Hungary","Finland","Iceland","South Africa","Japan","Mexico","Brazil",
  "Turkey","Egypt","South Korea","Argentina","Chile","Colombia","Peru"
]);

const FAMOUS_CITY_SEEDS_RAW = [
  ["London","United Kingdom",51.5072,-0.1276],["Manchester","United Kingdom",53.4808,-2.2426],
  ["Liverpool","United Kingdom",53.4084,-2.9916],["Birmingham","United Kingdom",52.4862,-1.8904],
  ["Leeds","United Kingdom",53.8008,-1.5491],["Sheffield","United Kingdom",53.3811,-1.4701],
  ["Newcastle upon Tyne","United Kingdom",54.9783,-1.6178],["Nottingham","United Kingdom",52.9548,-1.1581],
  ["Bristol","United Kingdom",51.4545,-2.5879],["Bath","United Kingdom",51.3811,-2.3590],
  ["Brighton","United Kingdom",50.8225,-0.1372],["Southampton","United Kingdom",50.9097,-1.4044],
  ["Portsmouth","United Kingdom",50.8198,-1.0880],["Plymouth","United Kingdom",50.3755,-4.1427],
  ["Exeter","United Kingdom",50.7184,-3.5339],["Norwich","United Kingdom",52.6309,1.2974],
  ["York","United Kingdom",53.9590,-1.0815],["Oxford","United Kingdom",51.7520,-1.2577],
  ["Cambridge","United Kingdom",52.2053,0.1218],["Canterbury","United Kingdom",51.2802,1.0789],
  ["Edinburgh","United Kingdom",55.9533,-3.1883],["Glasgow","United Kingdom",55.8642,-4.2518],
  ["Aberdeen","United Kingdom",57.1497,-2.0943],["Cardiff","United Kingdom",51.4816,-3.1791],
  ["Belfast","United Kingdom",54.5973,-5.9301],["Dublin","Ireland",53.3498,-6.2603],
  ["Cork","Ireland",51.8985,-8.4756],["Galway","Ireland",53.2707,-9.0568],

  ["New York City","United States",40.7128,-74.0060],["Los Angeles","United States",34.0522,-118.2437],
  ["Chicago","United States",41.8781,-87.6298],["San Francisco","United States",37.7749,-122.4194],
  ["Las Vegas","United States",36.1699,-115.1398],["Miami","United States",25.7617,-80.1918],
  ["Boston","United States",42.3601,-71.0589],["Washington, D.C.","United States",38.9072,-77.0369],
  ["Seattle","United States",47.6062,-122.3321],["New Orleans","United States",29.9511,-90.0715],
  ["Nashville","United States",36.1627,-86.7816],["Orlando","United States",28.5383,-81.3792],
  ["Philadelphia","United States",39.9526,-75.1652],["Detroit","United States",42.3314,-83.0458],
  ["Atlanta","United States",33.7490,-84.3880],["Dallas","United States",32.7767,-96.7970],
  ["Houston","United States",29.7604,-95.3698],["Austin","United States",30.2672,-97.7431],
  ["Denver","United States",39.7392,-104.9903],["Phoenix","United States",33.4484,-112.0740],
  ["San Diego","United States",32.7157,-117.1611],["Portland","United States",45.5152,-122.6784],

  ["Toronto","Canada",43.6532,-79.3832],["Vancouver","Canada",49.2827,-123.1207],
  ["Montreal","Canada",45.5017,-73.5673],["Quebec City","Canada",46.8139,-71.2080],
  ["Ottawa","Canada",45.4215,-75.6972],["Calgary","Canada",51.0447,-114.0719],

  ["Paris","France",48.8566,2.3522],["Marseille","France",43.2965,5.3698],
  ["Lyon","France",45.7640,4.8357],["Toulouse","France",43.6047,1.4442],
  ["Nice","France",43.7102,7.2620],["Bordeaux","France",44.8378,-0.5792],
  ["Lille","France",50.6292,3.0573],["Nantes","France",47.2184,-1.5536],
  ["Strasbourg","France",48.5734,7.7521],["Cannes","France",43.5528,7.0174],

  ["Berlin","Germany",52.5200,13.4050],["Munich","Germany",48.1351,11.5820],
  ["Hamburg","Germany",53.5511,9.9937],["Cologne","Germany",50.9375,6.9603],
  ["Frankfurt","Germany",50.1109,8.6821],["Düsseldorf","Germany",51.2277,6.7735],
  ["Stuttgart","Germany",48.7758,9.1829],["Dresden","Germany",51.0504,13.7373],
  ["Leipzig","Germany",51.3397,12.3731],["Bremen","Germany",53.0793,8.8017],

  ["Amsterdam","Netherlands",52.3676,4.9041],["Rotterdam","Netherlands",51.9244,4.4777],
  ["The Hague","Netherlands",52.0705,4.3007],["Utrecht","Netherlands",52.0907,5.1214],
  ["Brussels","Belgium",50.8503,4.3517],["Antwerp","Belgium",51.2194,4.4025],
  ["Bruges","Belgium",51.2093,3.2247],["Ghent","Belgium",51.0543,3.7174],
  ["Zurich","Switzerland",47.3769,8.5417],["Geneva","Switzerland",46.2044,6.1432],
  ["Bern","Switzerland",46.9480,7.4474],["Basel","Switzerland",47.5596,7.5886],
  ["Vienna","Austria",48.2082,16.3738],["Salzburg","Austria",47.8095,13.0550],

  ["Rome","Italy",41.9028,12.4964],["Milan","Italy",45.4642,9.1900],
  ["Venice","Italy",45.4408,12.3155],["Florence","Italy",43.7696,11.2558],
  ["Naples","Italy",40.8518,14.2681],["Turin","Italy",45.0703,7.6869],
  ["Bologna","Italy",44.4949,11.3426],["Palermo","Italy",38.1157,13.3615],
  ["Pisa","Italy",43.7228,10.4017],["Verona","Italy",45.4384,10.9916],

  ["Madrid","Spain",40.4168,-3.7038],["Barcelona","Spain",41.3874,2.1686],
  ["Valencia","Spain",39.4699,-0.3763],["Seville","Spain",37.3891,-5.9845],
  ["Bilbao","Spain",43.2630,-2.9350],["Granada","Spain",37.1773,-3.5986],
  ["Málaga","Spain",36.7213,-4.4214],["Palma","Spain",39.5696,2.6502],
  ["Lisbon","Portugal",38.7223,-9.1393],["Porto","Portugal",41.1579,-8.6291],

  ["Prague","Czechia",50.0755,14.4378],["Warsaw","Poland",52.2297,21.0122],
  ["Kraków","Poland",50.0647,19.9450],["Budapest","Hungary",47.4979,19.0402],
  ["Athens","Greece",37.9838,23.7275],["Copenhagen","Denmark",55.6761,12.5683],
  ["Stockholm","Sweden",59.3293,18.0686],["Oslo","Norway",59.9139,10.7522],
  ["Bergen","Norway",60.3913,5.3221],["Helsinki","Finland",60.1699,24.9384],
  ["Reykjavik","Iceland",64.1466,-21.9426],["Tallinn","Estonia",59.4370,24.7536],
  ["Riga","Latvia",56.9496,24.1052],["Vilnius","Lithuania",54.6872,25.2797],
  ["Zagreb","Croatia",45.8150,15.9819],["Dubrovnik","Croatia",42.6507,18.0944],

  ["Istanbul","Turkey",41.0082,28.9784],["Cairo","Egypt",30.0444,31.2357],
  ["Marrakesh","Morocco",31.6295,-7.9811],["Cape Town","South Africa",-33.9249,18.4241],
  ["Johannesburg","South Africa",-26.2041,28.0473],["Nairobi","Kenya",-1.2921,36.8219],
  ["Lagos","Nigeria",6.5244,3.3792],["Accra","Ghana",5.6037,-0.1870],
  ["Dubai","United Arab Emirates",25.2048,55.2708],["Abu Dhabi","United Arab Emirates",24.4539,54.3773],
  ["Doha","Qatar",25.2854,51.5310],["Jerusalem","Israel",31.7683,35.2137],

  ["Tokyo","Japan",35.6762,139.6503],["Kyoto","Japan",35.0116,135.7681],
  ["Osaka","Japan",34.6937,135.5023],["Seoul","South Korea",37.5665,126.9780],
  ["Beijing","China",39.9042,116.4074],["Shanghai","China",31.2304,121.4737],
  ["Hong Kong","China",22.3193,114.1694],["Bangkok","Thailand",13.7563,100.5018],
  ["Singapore","Singapore",1.3521,103.8198],["Kuala Lumpur","Malaysia",3.1390,101.6869],
  ["Hanoi","Vietnam",21.0278,105.8342],["Ho Chi Minh City","Vietnam",10.8231,106.6297],
  ["Jakarta","Indonesia",-6.2088,106.8456],["Bali","Indonesia",-8.4095,115.1889],
  ["Manila","Philippines",14.5995,120.9842],["Delhi","India",28.6139,77.2090],
  ["Mumbai","India",19.0760,72.8777],["Jaipur","India",26.9124,75.7873],
  ["Kathmandu","Nepal",27.7172,85.3240],["Colombo","Sri Lanka",6.9271,79.8612],
  ["Dhaka","Bangladesh",23.8103,90.4125],["Lahore","Pakistan",31.5204,74.3587],
  ["Tashkent","Uzbekistan",41.2995,69.2401],["Samarkand","Uzbekistan",39.6542,66.9597],
  ["Tbilisi","Georgia",41.7151,44.8271],["Baku","Azerbaijan",40.4093,49.8671],
  ["Ulaanbaatar","Mongolia",47.8864,106.9057],

  ["Sydney","Australia",-33.8688,151.2093],["Melbourne","Australia",-37.8136,144.9631],
  ["Brisbane","Australia",-27.4698,153.0251],["Perth","Australia",-31.9523,115.8613],
  ["Adelaide","Australia",-34.9285,138.6007],["Hobart","Australia",-42.8821,147.3272],
  ["Auckland","New Zealand",-36.8509,174.7645],["Wellington","New Zealand",-41.2865,174.7762],
  ["Christchurch","New Zealand",-43.5321,172.6362],["Queenstown","New Zealand",-45.0312,168.6626],

  ["Mexico City","Mexico",19.4326,-99.1332],["Cancún","Mexico",21.1619,-86.8515],
  ["Havana","Cuba",23.1136,-82.3666],["San Juan","Puerto Rico",18.4655,-66.1057],
  ["Rio de Janeiro","Brazil",-22.9068,-43.1729],["São Paulo","Brazil",-23.5558,-46.6396],
  ["Buenos Aires","Argentina",-34.6037,-58.3816],["Santiago","Chile",-33.4489,-70.6693],
  ["Lima","Peru",-12.0464,-77.0428],["Cusco","Peru",-13.5320,-71.9675],
  ["Bogotá","Colombia",4.7110,-74.0721],["Medellín","Colombia",6.2442,-75.5812],
  ["Cartagena","Colombia",10.3910,-75.4794],["Quito","Ecuador",-0.1807,-78.4678],
  ["La Paz","Bolivia",-16.4897,-68.1193],["Montevideo","Uruguay",-34.9011,-56.1645]
];

const FAMOUS_CITY_SEEDS = FAMOUS_CITY_SEEDS_RAW.map(([displayName, country, lat, lng]) => ({
  name: `${displayName}, ${country}`,
  displayName,
  sourceName: displayName,
  country,
  lat,
  lng,
  curated: true
}));

// Server-side only chaos fallback pool.
// Used when Wikidata times out or returns too few candidates for chaos mode.
// Real cities/places with approximate city-centre coordinates, intentionally
// harder than the familiar pool: remote capitals, obscure island capitals,
// and extreme geography locations.
const CHAOS_CITY_SEEDS_RAW = [
  ["Nukus","Uzbekistan",42.4531,59.6103],
  ["Yakutsk","Russia",62.0355,129.6755],
  ["Iqaluit","Canada",63.7467,-68.5170],
  ["Longyearbyen","Norway",78.2232,15.6267],
  ["Tórshavn","Faroe Islands",62.0079,-6.7900],
  ["Stanley","Falkland Islands",-51.6938,-57.8517],
  ["Dili","Timor-Leste",-8.5569,125.5603],
  ["Paramaribo","Suriname",5.8520,-55.2038],
  ["Georgetown","Guyana",6.8013,-58.1551],
  ["Asmara","Eritrea",15.3229,38.9251],
  ["Djibouti","Djibouti",11.8251,42.5903],
  ["Bissau","Guinea-Bissau",11.8636,-15.5977],
  ["Praia","Cape Verde",14.9330,-23.5133],
  ["Banjul","Gambia",13.4549,-16.5790],
  ["Conakry","Guinea",9.6412,-13.5784],
  ["Freetown","Sierra Leone",8.4657,-13.2317],
  ["Monrovia","Liberia",6.3007,-10.7969],
  ["Timbuktu","Mali",16.7666,-3.0026],
  ["Agadez","Niger",16.9742,7.9909],
  ["N'Djamena","Chad",12.1348,15.0557],
  ["Bangui","Central African Republic",4.3947,18.5582],
  ["Malabo","Equatorial Guinea",3.7523,8.7742],
  ["São Tomé","São Tomé and Príncipe",0.3302,6.7333],
  ["Moroni","Comoros",-11.7172,43.2473],
  ["Antsiranana","Madagascar",-12.2787,49.2917],
  ["Windhoek","Namibia",-22.5609,17.0658],
  ["Gaborone","Botswana",-24.6282,25.9231],
  ["Maseru","Lesotho",-29.3151,27.4869],
  ["Mbabane","Eswatini",-26.3054,31.1367],
  ["Juba","South Sudan",4.8517,31.5825],
  ["Hargeisa","Somaliland",9.5600,44.0650],
  ["Lhasa","China",29.6500,91.1000],
  ["Urumqi","China",43.8256,87.6168],
  ["Kashgar","China",39.4704,75.9898],
  ["Thimphu","Bhutan",27.4716,89.6386],
  ["Paro","Bhutan",27.4287,89.4164],
  ["Vientiane","Laos",17.9757,102.6331],
  ["Naypyidaw","Myanmar",19.7633,96.0785],
  ["Bandar Seri Begawan","Brunei",4.9031,114.9398],
  ["Dushanbe","Tajikistan",38.5598,68.7870],
  ["Bishkek","Kyrgyzstan",42.8746,74.5698],
  ["Ashgabat","Turkmenistan",37.9601,58.3261],
  ["Ulaanbaatar","Mongolia",47.8864,106.9057],
  ["Astana","Kazakhstan",51.1605,71.4704],
  ["Almaty","Kazakhstan",43.2389,76.8897],
  ["Malé","Maldives",4.1755,73.5093],
  ["Port Moresby","Papua New Guinea",-9.4438,147.1803],
  ["Honiara","Solomon Islands",-9.4456,159.9729],
  ["Suva","Fiji",-18.1416,178.4419],
  ["Apia","Samoa",-13.8506,-171.7513],
  ["Nukuʻalofa","Tonga",-21.1394,-175.2049],
  ["Port Vila","Vanuatu",-17.7404,168.3220],
  ["Palikir","Micronesia",6.9248,158.1611],
  ["Majuro","Marshall Islands",7.0894,171.3803],
  ["Tarawa","Kiribati",1.3382,172.9759],
  ["Funafuti","Tuvalu",-8.5243,179.1942],
  ["Nuuk","Greenland",64.1836,-51.7214],
  ["Kangerlussuaq","Greenland",67.0067,-50.6892],
  ["Ushuaia","Argentina",-54.8019,-68.3030],
  ["Punta Arenas","Chile",-53.1638,-70.9171],
  ["Hanga Roa","Chile",-27.1500,-109.4333],
  ["Potosí","Bolivia",-19.5836,-65.7531],
  ["Sucre","Bolivia",-19.0196,-65.2619],
  ["Iquitos","Peru",-3.7437,-73.2516],
  ["Leticia","Colombia",-4.2150,-69.9406],
  ["Cayenne","French Guiana",4.9224,-52.3135],
  ["Oranjestad","Aruba",12.5211,-70.0353],
  ["Willemstad","Curaçao",12.1098,-68.9335],
  ["Road Town","British Virgin Islands",18.4267,-64.6231],
  ["Basseterre","Saint Kitts and Nevis",17.2955,-62.7261],
  ["Castries","Saint Lucia",14.0101,-60.9874],
  ["Roseau","Dominica",15.3092,-61.3794],
  ["St. George's","Grenada",12.0561,-61.7488],
  ["Kingstown","Saint Vincent and the Grenadines",13.1567,-61.2248],
  ["Belmopan","Belize",17.2510,-88.7590],
  ["Tegucigalpa","Honduras",14.0723,-87.1921],
  ["Managua","Nicaragua",12.1149,-86.2362],
  ["Saint-Pierre","Saint Pierre and Miquelon",46.7811,-56.1714],
  ["Hamilton","Bermuda",32.2949,-64.7822],
  ["Jamestown","Saint Helena",-15.9387,-5.7177],
  ["Avarua","Cook Islands",-21.2074,-159.7746],
  ["Adamstown","Pitcairn Islands",-25.0664,-130.0995],
  ["Alofi","Niue",-19.0556,-169.9171],
  ["Mata-Utu","Wallis and Futuna",-13.2825,-176.1745]
];

const CHAOS_CITY_SEEDS = CHAOS_CITY_SEEDS_RAW.map(([displayName, country, lat, lng]) => ({
  name: `${displayName}, ${country}`,
  displayName,
  sourceName: displayName,
  country,
  lat,
  lng,
  curated: true,
  chaos: true
}));

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
  const chosenCountries = [];
  const chosen = [];
  const target = clamp(Number(count || 10), 1, 25);
  const seedFamiliar = options.seedFamiliar !== false;

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
    const usedNames = new Set(chosen.map(city => city.name));
    for (const city of shuffleCopy(pool)) {
      if (chosen.length >= target) break;
      if (usedNames.has(city.name)) continue;
      usedNames.add(city.name);
      chosen.push(city);
    }
  }

  if (chosen.length < target) {
    throw new Error(`Not enough curated cities. Needed ${target}, got ${chosen.length}.`);
  }

  return chosen.slice(0, target);
}

function curatedQuestions(count, options = {}) {
  const difficulty = String(options.cityDifficulty || "mixed").toLowerCase();
  return pickOneCityPerCountry(FAMOUS_CITY_SEEDS, count, { seedFamiliar: difficulty !== "chaos" });
}

function chaosFallbackQuestions(count, options = {}) {
  const target = clamp(Number(count || 10), 1, 25);
  const pool = uniqueCityPool(CHAOS_CITY_SEEDS);
  const groups = groupCitiesByCountry(pool);
  const chosen = [];
  const usedKeys = new Set();

  const keyOf = (city) => `${city.name}|${Number(city.lat).toFixed(3)}|${Number(city.lng).toFixed(3)}`;

  for (const country of shuffleCopy([...groups.keys()])) {
    if (chosen.length >= target) break;
    const pick = shuffleCopy(groups.get(country))[0];
    if (!pick) continue;
    chosen.push(pick);
    usedKeys.add(keyOf(pick));
  }

  if (chosen.length < target) {
    for (const city of shuffleCopy(pool)) {
      if (chosen.length >= target) break;
      const key = keyOf(city);
      if (usedKeys.has(key)) continue;
      chosen.push(city);
      usedKeys.add(key);
    }
  }

  // Last-resort: if pool is somehow tiny, allow repeats so we never throw.
  while (chosen.length < target && pool.length > 0) {
    chosen.push(shuffleCopy(pool)[0]);
  }

  return chosen.slice(0, target);
}

function parseWikidataPoint(pointValue) {
  const cleaned = String(pointValue || "").replace("Point(", "").replace(")", "");
  const parts = cleaned.split(" ").map(Number);
  if (parts.length !== 2 || Number.isNaN(parts[0]) || Number.isNaN(parts[1])) return null;
  return { lng: parts[0], lat: parts[1] };
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

function buildQuery({ difficulty = "mixed", limit = 160 } = {}) {
  const minPopulation = difficulty === "chaos" ? 50000 : 150000;
  const countryFilter = difficulty === "mixed"
    ? `VALUES ?country { ${FAMILIAR_COUNTRY_QIDS.map(qid => `wd:${qid}`).join(" ")} }`
    : "";

  return `
    SELECT ?city ?cityLabel ?countryLabel ?coord ?population WHERE {
      ${countryFilter}
      ?city wdt:P31/wdt:P279* wd:Q515;
            wdt:P625 ?coord;
            wdt:P17 ?country;
            wdt:P1082 ?population.
      FILTER(?population >= ${minPopulation})
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }
    ORDER BY DESC(?population)
    LIMIT ${limit}
  `;
}

function withTimeout(promise, ms = 3000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms))
  ]);
}

async function runWikidataQuery(query, timeoutMs = 3000) {
  const url = `${CITY_LOOKUP_ENDPOINT}?query=${encodeURIComponent(query)}&format=json`;
  const response = await withTimeout(fetch(url, {
    headers: {
      Accept: "application/sparql-results+json",
      "User-Agent": "PinThePlanet/0.1 (https://world-pin-quiz.vercel.app)"
    }
  }), timeoutMs);

  if (!response.ok) {
    throw new Error(`Wikidata ${response.status}`);
  }

  const data = await response.json();
  const rows = data?.results?.bindings || [];
  return rows.map((row) => {
    const coords = parseWikidataPoint(row.coord?.value);
    const city = row.cityLabel?.value;
    const country = row.countryLabel?.value;
    if (!coords || !city || !country) return null;
    const displayName = cleanLocationDisplayName(city);
    return {
      name: `${displayName}, ${country}`,
      displayName,
      sourceName: city,
      country,
      lat: coords.lat,
      lng: coords.lng,
      population: Number(row.population?.value || row.pop?.value || 0),
      source: "wikidata"
    };
  }).filter(Boolean);
}

async function getWikidataCandidates(count, options = {}, debug = {}) {
  const difficulty = String(options.cityDifficulty || "mixed").toLowerCase();
  const limit = difficulty === "chaos" ? 260 : 180;
  const timeoutMs = difficulty === "chaos" ? 4200 : 2600;
  debug.wikidataAttempted = true;
  debug.wikidataDifficulty = difficulty;
  debug.wikidataLimit = limit;
  debug.wikidataTimeoutMs = timeoutMs;
  try {
    const rows = await runWikidataQuery(buildQuery({ difficulty, limit }), timeoutMs);
    debug.wikidataSuccess = true;
    debug.wikidataReturned = rows.length;
    return shuffleCopy(uniqueCityPool(rows));
  } catch (error) {
    debug.wikidataSuccess = false;
    debug.wikidataError = error?.message || String(error);
    return [];
  }
}

async function buildQuestions(count, options, debug = {}) {
  const target = clamp(Number(count || 10), 1, 25);
  const difficulty = String(options.cityDifficulty || "mixed").toLowerCase();
  const curatedPool = uniqueCityPool(FAMOUS_CITY_SEEDS);
  debug.mode = difficulty;
  debug.curatedPoolSize = curatedPool.length;

  if (difficulty === "familiar") {
    debug.wikidataAttempted = false;
    debug.curatedRequested = target;
    const questions = curatedQuestions(target, { ...options, cityDifficulty: "familiar" });
    debug.returnedFromCurated = questions.length;
    return questions;
  }

  if (difficulty === "mixed") {
    const curatedTarget = Math.max(1, Math.ceil(target * 0.75));
    const wildcardTarget = target - curatedTarget;
    const curated = curatedQuestions(curatedTarget, { ...options, cityDifficulty: "mixed" });
    const usedCountries = new Set(curated.map(city => city.country));
    debug.curatedRequested = curatedTarget;
    debug.wikidataWildcardTarget = wildcardTarget;

    let wildcards = [];
    if (wildcardTarget > 0) {
      const candidates = await getWikidataCandidates(target + 20, { ...options, cityDifficulty: "mixed" }, debug);
      wildcards = candidates.filter(city => !usedCountries.has(city.country)).slice(0, wildcardTarget);
    }
    let combined = uniqueCityPool([...curated, ...wildcards]);
    debug.wikidataUsed = wildcards.length;
    if (combined.length < target) {
      const usedNames = new Set(combined.map(city => city.name));
      const fallback = shuffleCopy(curatedPool).filter(city => !usedNames.has(city.name));
      combined = uniqueCityPool([...combined, ...fallback]).slice(0, target);
      debug.curatedFallbackUsed = true;
    }
    return combined.slice(0, target);
  }

  const candidates = await getWikidataCandidates(target + 30, { ...options, cityDifficulty: "chaos" }, debug);
  debug.chaosPoolSize = CHAOS_CITY_SEEDS.length;
  if (candidates.length >= target) {
    const questions = pickOneCityPerCountry(candidates, target, { seedFamiliar: false });
    debug.wikidataUsed = questions.length;
    return questions;
  }

  debug.chaosFallbackUsed = true;
  debug.wikidataUsed = 0;
  return chaosFallbackQuestions(target, { ...options, cityDifficulty: "chaos" });
}

async function makeQuestionPayload(req) {
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
  const debug = { requestedCount: count, options };

  if (options.questionType !== "city") {
    options.questionType = "city";
    debug.questionTypeForcedToCity = true;
  }

  let questions = await buildQuestions(count, options, debug);
  if (!Array.isArray(questions) || questions.length < count) {
    debug.emergencyFallback = true;
    questions = curatedQuestions(count, options);
  }

  return {
    apiVersion: API_VERSION,
    generatedAt: new Date().toISOString(),
    count: questions.length,
    difficulty: options.cityDifficulty,
    source:
      options.cityDifficulty === "familiar"
        ? "curated"
        : options.cityDifficulty === "mixed"
          ? (debug.wikidataUsed > 0 ? "curated-plus-wikidata" : "curated")
          : (debug.wikidataUsed > 0 ? "wikidata" : "chaos-fallback"),
    debug,
    questions
  };
}

module.exports = async function handler(req, res) {
  try {
    const payload = await makeQuestionPayload(req);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(payload);
  } catch (error) {
    try {
      const count = clamp(Number(req.query.count || 10), 1, 25);
      const difficulty = String(req.query.cityDifficulty || req.query.difficulty || "mixed").toLowerCase();
      const questions = curatedQuestions(count, { cityDifficulty: difficulty });
      return res.status(200).json({
        apiVersion: API_VERSION,
        generatedAt: new Date().toISOString(),
        count: questions.length,
        difficulty,
        source: "emergency-curated-fallback",
        debug: { emergencyFallback: true, error: error?.message || String(error) },
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
