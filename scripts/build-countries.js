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

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function ringCentroid(ring) {
  // Cheap area-weighted centroid in lat/lng space. Good enough for picking
  // the "main territory" of a MultiPolygon, which is all we need here.
  let area = 0, cx = 0, cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const f = xj * yi - xi * yj;
    area += f;
    cx += (xi + xj) * f;
    cy += (yi + yj) * f;
  }
  area *= 0.5;
  if (Math.abs(area) < 1e-9) {
    let sx = 0, sy = 0;
    for (const [x, y] of ring) { sx += x; sy += y; }
    return [sx / ring.length, sy / ring.length];
  }
  return [cx / (6 * area), cy / (6 * area)];
}

function ringBoundsArea(ring) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return (maxX - minX) * (maxY - minY);
}

// Drop "overseas" parts of a MultiPolygon when they're far from the
// label point. This stops e.g. French Guiana from counting as France
// in gameplay and from yanking the reveal map across the Atlantic.
// Tuned to keep mainland + nearby (Corsica, Alaska, Hawaii, NI) but
// drop genuinely far-flung territories (Guiana, Reunion, Falklands).
const OVERSEAS_RADIUS_KM = 6500;

function filterOverseas(geometry, labelLat, labelLng) {
  if (!geometry || geometry.type !== "MultiPolygon") return geometry;
  if (!Number.isFinite(labelLat) || !Number.isFinite(labelLng)) return geometry;

  // Find the largest polygon by bounding-box area. Always keep that one
  // even if its centroid is far from the label, in case the label point
  // is on a different polygon.
  let largestIdx = 0, largestSize = -1;
  geometry.coordinates.forEach((poly, i) => {
    const a = ringBoundsArea(poly[0]);
    if (a > largestSize) { largestSize = a; largestIdx = i; }
  });

  const kept = geometry.coordinates.filter((poly, i) => {
    if (i === largestIdx) return true;
    const [cLng, cLat] = ringCentroid(poly[0]);
    const distToLabel = haversineKm(cLat, cLng, labelLat, labelLng);
    if (distToLabel <= OVERSEAS_RADIUS_KM) return true;
    // Also keep if it's near the largest polygon's centroid (e.g. a
    // small island just off the mainland coast).
    const [lLng, lLat] = ringCentroid(geometry.coordinates[largestIdx][0]);
    const distToLargest = haversineKm(cLat, cLng, lLat, lLng);
    return distToLargest <= OVERSEAS_RADIUS_KM;
  });

  if (kept.length === geometry.coordinates.length) return geometry;
  return { type: "MultiPolygon", coordinates: kept };
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
  const labelLat = typeof p.LABEL_Y === "number" ? round3(p.LABEL_Y) : null;
  const labelLng = typeof p.LABEL_X === "number" ? round3(p.LABEL_X) : null;
  const rounded = {
    type: f.geometry.type,
    coordinates: roundCoords(f.geometry.coordinates)
  };
  const trimmed = filterOverseas(rounded, labelLat, labelLng);
  return {
    type: "Feature",
    properties: {
      name,
      displayName: name,
      iso: p.ISO_A2 && p.ISO_A2 !== "-99" ? p.ISO_A2 : (p.ISO_A2_EH || ""),
      iso3: p.ISO_A3 && p.ISO_A3 !== "-99" ? p.ISO_A3 : (p.ISO_A3_EH || ""),
      continent: p.CONTINENT || "",
      labelLat,
      labelLng
    },
    geometry: trimmed
  };
}).filter(f => f.properties.name && !SKIP_NAMES.has(f.properties.name));

const out = { type: "FeatureCollection", features };
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`features: ${features.length}`);
console.log(`bytes: ${fs.statSync(OUT).size}`);
