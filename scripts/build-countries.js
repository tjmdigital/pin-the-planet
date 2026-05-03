// Build data/countries.geojson from Natural Earth 1:110m admin_0_countries.
// Strips properties to a small set and rounds coordinates to 3 decimal
// places (~110m precision) to keep the file compact for serverless use.
//
// Source: Natural Earth (public domain) via the natural-earth-vector repo.
// https://github.com/nvkelso/natural-earth-vector
//
// Run once with the raw NE file present at /tmp/ne_110m.geojson.
const fs = require("fs");
const path = require("path");

const SRC = "/tmp/ne_110m.geojson";
const OUT = path.join(__dirname, "..", "data", "countries.geojson");

function round3(n) { return Math.round(n * 1000) / 1000; }

function roundCoords(arr) {
  if (typeof arr[0] === "number") {
    return [round3(arr[0]), round3(arr[1])];
  }
  return arr.map(roundCoords);
}

const raw = JSON.parse(fs.readFileSync(SRC, "utf8"));

// Friendly-name overrides for cases where Natural Earth's NAME differs
// from the colloquial pub-quiz English name we want to show players.
const NAME_OVERRIDES = {
  "People's Republic of China": "China",
  "United States of America": "United States",
  "Republic of the Congo": "Republic of the Congo",
  "Democratic Republic of the Congo": "Democratic Republic of the Congo",
  "Republic of Serbia": "Serbia",
  "Czech Republic": "Czechia",
  "Republic of Tanzania": "Tanzania",
  "United Republic of Tanzania": "Tanzania",
  "Macedonia": "North Macedonia",
  "Ivory Coast": "Côte d'Ivoire",
  "Eswatini": "Eswatini",
  "Swaziland": "Eswatini",
  "Burma": "Myanmar",
  "East Timor": "Timor-Leste",
  "The Bahamas": "Bahamas",
  "Cape Verde": "Cape Verde",
  "Cabo Verde": "Cape Verde",
  "Vatican": "Vatican City",
  "Brunei": "Brunei",
  "Pitcairn Islands": "Pitcairn Islands"
};

// Skip these features. Antarctica is huge and weird; small disputed
// regions and uninhabited territories make for poor quiz prompts.
const SKIP_NAMES = new Set([
  "Antarctica",
  "Northern Cyprus",
  "Somaliland",
  "Kosovo", // disputed; keep out of default pool
  "Western Sahara",
  "French Southern and Antarctic Lands",
  "Heard I. and McDonald Is.",
  "South Georgia and the Islands",
  "Indian Ocean Ter."
]);

const features = raw.features.map((f) => {
  const p = f.properties || {};
  const rawName = p.NAME_EN || p.NAME || p.ADMIN || p.NAME_LONG;
  const name = NAME_OVERRIDES[rawName] || rawName;
  return {
    type: "Feature",
    properties: {
      name,
      displayName: name,
      iso: p.ISO_A2 && p.ISO_A2 !== "-99" ? p.ISO_A2 : (p.ISO_A2_EH || ""),
      iso3: p.ISO_A3 && p.ISO_A3 !== "-99" ? p.ISO_A3 : (p.ISO_A3_EH || ""),
      continent: p.CONTINENT || "",
      labelLat: typeof p.LABEL_Y === "number" ? round3(p.LABEL_Y) : null,
      labelLng: typeof p.LABEL_X === "number" ? round3(p.LABEL_X) : null
    },
    geometry: {
      type: f.geometry.type,
      coordinates: roundCoords(f.geometry.coordinates)
    }
  };
}).filter(f => f.properties.name && !SKIP_NAMES.has(f.properties.name));

const out = { type: "FeatureCollection", features };
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`features: ${features.length}`);
console.log(`bytes: ${fs.statSync(OUT).size}`);
