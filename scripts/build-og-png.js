// One-shot script: render og.svg to og.png at 1200x630 via headless
// Chromium. Safe to delete after the PNG exists; or keep it under
// scripts/ so the OG image can be rebuilt if og.svg changes.
const path = require("path");
const { chromium } = require("/opt/node22/lib/node_modules/playwright");

(async () => {
  const fs = require("fs");
  const repo = path.join(__dirname, "..");
  const svgPath = path.join(repo, "og.svg");
  const pngPath = path.join(repo, "og.png");
  const svg = fs.readFileSync(svgPath, "utf8");

  // Wrap the SVG in a minimal HTML page so we have a real DOM to
  // screenshot at exactly 1200x630.
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; padding: 0; background: transparent; }
    svg { display: block; width: 1200px; height: 630px; }
  </style></head><body>${svg}</body></html>`;

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "networkidle" });
  await page.screenshot({ path: pngPath, fullPage: false, clip: { x: 0, y: 0, width: 1200, height: 630 } });
  await browser.close();

  console.log(`Wrote ${pngPath} (${fs.statSync(pngPath).size} bytes)`);
})().catch(err => { console.error(err); process.exit(1); });
