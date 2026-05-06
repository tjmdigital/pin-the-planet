// Build data/counties-uk.geojson and data/states-us.geojson from
// Natural Earth 1:10m admin level 1.
//
// UK ceremonial counties: NE has most as direct features but the
// metropolitan counties (Greater London, Greater Manchester, etc) are
// represented as boroughs. We merge those by collecting all member
// boroughs into a MultiPolygon for each metropolitan county.
//
// US: 50 states + DC, all direct features.
//
// Source: Natural Earth (public domain). Run once with the raw NE
// admin_1 10m file at /tmp/ne_admin1_10m.geojson.

const fs = require("fs");
const path = require("path");

const SRC = "/tmp/ne_admin1_10m.geojson";
const COUNTIES_OUT = path.join(__dirname, "..", "data", "counties-uk.geojson");
const STATES_OUT = path.join(__dirname, "..", "data", "states-us.geojson");

function round3(n) { return Math.round(n * 1000) / 1000; }
function round2(n) { return Math.round(n * 100) / 100; }
function round1(n) { return Math.round(n * 10) / 10; }

// Round to N dp and drop runs of identical points so the rounded
// polygon doesn't accumulate noise. Polygons with fewer than 4
// surviving points are dropped (they'd be a useless sliver anyway).
function simplifyRing(ring, dp) {
  const round = dp === 1 ? round1 : dp === 2 ? round2 : round3;
  const out = [];
  let lastX = null, lastY = null;
  for (const [x, y] of ring) {
    const rx = round(x), ry = round(y);
    if (rx === lastX && ry === lastY) continue;
    out.push([rx, ry]);
    lastX = rx; lastY = ry;
  }
  // Ensure closed ring.
  if (out.length > 1) {
    const first = out[0], last = out[out.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) out.push([first[0], first[1]]);
  }
  return out;
}

function simplifyPolygon(poly, dp) {
  return poly.map(ring => simplifyRing(ring, dp)).filter(r => r.length >= 4);
}

function simplifyGeometry(geometry, dp = 3) {
  if (!geometry) return geometry;
  if (geometry.type === "Polygon") {
    const polys = [simplifyPolygon(geometry.coordinates, dp)].filter(p => p.length);
    if (!polys.length) return null;
    return { type: "Polygon", coordinates: polys[0] };
  }
  if (geometry.type === "MultiPolygon") {
    const polys = geometry.coordinates.map(p => simplifyPolygon(p, dp)).filter(p => p.length);
    if (!polys.length) return null;
    return { type: "MultiPolygon", coordinates: polys };
  }
  return geometry;
}

function roundCoords(arr) {
  if (typeof arr[0] === "number") return [round3(arr[0]), round3(arr[1])];
  return arr.map(roundCoords);
}

function ringCentroid(ring) {
  let sx = 0, sy = 0;
  for (const [x, y] of ring) { sx += x; sy += y; }
  return [sx / ring.length, sy / ring.length];
}

function bestLabelPoint(geometry) {
  // Largest polygon's centroid is a "good enough" label point.
  let largest = null, largestSize = -1;
  const polygons = geometry.type === "MultiPolygon" ? geometry.coordinates : [geometry.coordinates];
  for (const poly of polygons) {
    const ring = poly[0];
    let minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity;
    for (const [x, y] of ring) {
      if (x<minX) minX=x; if (x>maxX) maxX=x;
      if (y<minY) minY=y; if (y>maxY) maxY=y;
    }
    const size = (maxX - minX) * (maxY - minY);
    if (size > largestSize) { largestSize = size; largest = ring; }
  }
  return largest ? ringCentroid(largest) : [0, 0];
}

function asMultiPolygon(geometry) {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  return [];
}

const raw = JSON.parse(fs.readFileSync(SRC, "utf8"));

// --- UK ceremonial counties ----------------------------------------------
// Most ceremonial counties have one or more unitary authorities carved
// out of them (eg Southampton + Portsmouth from Hampshire). Including
// the unitary authority in the ceremonial county geometry means a
// pin in Southampton scores as Hampshire, which is what most players
// will expect.
const ukFeatures = raw.features.filter(f => f.properties.admin === "United Kingdom");

const directMatches = [
  "Bristol","Cornwall","Cumbria","Durham","Herefordshire",
  "Isle of Wight","Merseyside","Northumberland","Rutland","Shropshire"
];

// Counties that need merging with their carved-out unitaries to match
// the ceremonial boundary players expect.
const mergedCounties = {
  "Bedfordshire": ["Bedford","Central Bedfordshire","Luton"],
  "Berkshire": ["Reading","West Berkshire","Wokingham","Bracknell Forest","Slough","Windsor and Maidenhead","Royal Borough of Windsor and Maidenhead"],
  "Buckinghamshire": ["Buckinghamshire","Milton Keynes"],
  "Cambridgeshire": ["Cambridgeshire","Peterborough"],
  "Cheshire": ["Cheshire East","Cheshire West and Chester","Halton","Warrington"],
  "Derbyshire": ["Derbyshire","Derby"],
  "Devon": ["Devon","Plymouth","Torbay"],
  "Dorset": ["Dorset","Bournemouth","Bournemouth, Christchurch and Poole","Poole","Christchurch"],
  "East Riding of Yorkshire": ["East Riding of Yorkshire","Kingston upon Hull"],
  "East Sussex": ["East Sussex","Brighton and Hove"],
  "Essex": ["Essex","Southend-on-Sea","Thurrock"],
  "Gloucestershire": ["Gloucestershire","South Gloucestershire"],
  "Hampshire": ["Hampshire","Southampton","Portsmouth"],
  "Hertfordshire": ["Hertfordshire"],
  "Kent": ["Kent","Medway"],
  "Lancashire": ["Lancashire","Blackburn with Darwen","Blackpool"],
  "Leicestershire": ["Leicestershire","Leicester"],
  "Lincolnshire": ["Lincolnshire","North Lincolnshire","North East Lincolnshire"],
  "Norfolk": ["Norfolk"],
  "Northamptonshire": ["Northamptonshire","West Northamptonshire","North Northamptonshire"],
  "North Yorkshire": ["North Yorkshire","York","Middlesbrough","Redcar and Cleveland","Stockton-on-Tees"],
  "Nottinghamshire": ["Nottinghamshire","Nottingham"],
  "Oxfordshire": ["Oxfordshire"],
  "Somerset": ["Somerset","Bath and North East Somerset","North Somerset"],
  "Staffordshire": ["Staffordshire","Stoke-on-Trent"],
  "Suffolk": ["Suffolk"],
  "Surrey": ["Surrey"],
  "Warwickshire": ["Warwickshire"],
  "West Sussex": ["West Sussex"],
  "Wiltshire": ["Wiltshire","Swindon"],
  "Worcestershire": ["Worcestershire"],
  // Metropolitan counties (built from boroughs).
  "Greater London": [
    "Westminster","City of London","Camden","Islington","Hackney","Tower Hamlets","Newham","Greenwich","Lewisham","Southwark",
    "Lambeth","Wandsworth","Hammersmith and Fulham","Kensington and Chelsea","Royal Borough of Kensington and Chelsea",
    "Brent","Ealing","Hounslow","Richmond upon Thames","Kingston upon Thames","Royal Borough of Kingston upon Thames",
    "Merton","Sutton","Croydon","Bromley","Bexley","Havering","Barking and Dagenham","Redbridge","Waltham Forest",
    "Enfield","Haringey","Barnet","Harrow","Hillingdon"
  ],
  "Greater Manchester": ["Manchester","Salford","Trafford","Stockport","Tameside","Oldham","Rochdale","Bury","Bolton","Wigan"],
  "South Yorkshire": ["Sheffield","Rotherham","Doncaster","Barnsley"],
  "Tyne and Wear": ["Newcastle upon Tyne","North Tyneside","South Tyneside","Sunderland","Gateshead"],
  "West Midlands": ["Birmingham","Coventry","Wolverhampton","Solihull","Dudley","Sandwell","Walsall"],
  "West Yorkshire": ["Leeds","Bradford","Wakefield","Calderdale","Kirklees"]
};

function findUKFeature(name) {
  return ukFeatures.find(f => f.properties.name === name)
    || ukFeatures.find(f => (f.properties.name || "").toLowerCase() === name.toLowerCase());
}

function mergeMembersGeometry(memberNames) {
  const combined = [];
  const found = [];
  const missed = [];
  for (const member of memberNames) {
    const f = findUKFeature(member);
    if (!f) { missed.push(member); continue; }
    found.push(member);
    asMultiPolygon(f.geometry).forEach(poly => combined.push(poly));
  }
  return { combined, found, missed };
}

const countyFeatures = [];

for (const name of directMatches) {
  const f = findUKFeature(name);
  if (!f) { console.warn("MISS direct:", name); continue; }
  const geometry = simplifyGeometry(f.geometry, 3);
  if (!geometry) { console.warn("Empty geometry for:", name); continue; }
  const [lng, lat] = bestLabelPoint(geometry);
  countyFeatures.push({
    type: "Feature",
    properties: {
      name,
      displayName: name,
      country: "United Kingdom",
      iso: "GB",
      labelLat: round3(lat),
      labelLng: round3(lng),
      kind: "county-uk"
    },
    geometry
  });
}

for (const [name, members] of Object.entries(mergedCounties)) {
  const { combined, found, missed } = mergeMembersGeometry(members);
  if (!combined.length) {
    console.warn("MISS merged:", name, "missed:", missed);
    continue;
  }
  if (missed.length) console.warn("Partial merged:", name, "missing members:", missed);
  const merged = { type: "MultiPolygon", coordinates: combined };
  const geometry = simplifyGeometry(merged, 3);
  if (!geometry) { console.warn("Empty merged geometry for:", name); continue; }
  const [lng, lat] = bestLabelPoint(geometry);
  countyFeatures.push({
    type: "Feature",
    properties: {
      name,
      displayName: name,
      country: "United Kingdom",
      iso: "GB",
      labelLat: round3(lat),
      labelLng: round3(lng),
      kind: "county-uk",
      mergedFrom: found.length
    },
    geometry
  });
}

countyFeatures.sort((a, b) => a.properties.name.localeCompare(b.properties.name));

fs.writeFileSync(
  COUNTIES_OUT,
  JSON.stringify({ type: "FeatureCollection", features: countyFeatures })
);
console.log(`UK counties: ${countyFeatures.length} features, ${fs.statSync(COUNTIES_OUT).size} bytes`);

// --- US states -----------------------------------------------------------
const usFeatures = raw.features.filter(f => f.properties.admin === "United States of America");
const stateFeatures = usFeatures.map(f => {
  const name = f.properties.name;
  // 2dp = ~1km precision, plenty for state-level scoring. Alaska alone
  // at 2dp is still 280KB because of the Aleutian Islands; bump it
  // down to 1dp (~10km precision) - more than fine for a state the
  // size of Alaska.
  const dp = name === "Alaska" ? 1 : 2;
  const geometry = simplifyGeometry(f.geometry, dp);
  if (!geometry) return null;
  const [lng, lat] = bestLabelPoint(geometry);
  return {
    type: "Feature",
    properties: {
      name,
      displayName: name,
      country: "United States",
      iso: "US",
      stateCode: f.properties.iso_3166_2 || f.properties.postal || "",
      labelLat: round3(lat),
      labelLng: round3(lng),
      kind: "state-us"
    },
    geometry
  };
});
const cleanedStates = stateFeatures.filter(Boolean);
cleanedStates.sort((a, b) => a.properties.name.localeCompare(b.properties.name));
stateFeatures.length = 0;
cleanedStates.forEach(f => stateFeatures.push(f));

fs.writeFileSync(
  STATES_OUT,
  JSON.stringify({ type: "FeatureCollection", features: stateFeatures })
);
console.log(`US states: ${stateFeatures.length} features, ${fs.statSync(STATES_OUT).size} bytes`);
