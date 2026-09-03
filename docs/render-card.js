// Renders docs/tweet-card.html to docs/tweet-card.png (needs playwright + chromium):
//   node docs/render-card.js docs/tweet-card.html docs/tweet-card.png 1600 900 2
const { chromium } = require('playwright');
(async () => {
  const [, , input, output, w = '1600', h = '900', scale = '2'] = process.argv;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: Number(scale) });
  await page.goto('file://' + require('path').resolve(input));
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({ path: output, clip: { x: 0, y: 0, width: Number(w), height: Number(h) } });
  await browser.close();
  console.log('wrote', output);
})().catch((e) => { console.error(e); process.exit(1); });
