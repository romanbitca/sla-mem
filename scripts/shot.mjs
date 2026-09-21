// Dev helper: launches the built app with Playwright, optionally navigates to hash routes, and
// saves screenshots. Usage: node scripts/shot.mjs <outDir> [route ...]   (routes like "#/search?q=x")
import path from 'node:path';
import fs from 'node:fs';
import { _electron as electron } from 'playwright-core';

const [outDir = '.shots', ...routes] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SLACK_ARCHIVE_E2E: '1' },
});
const page = await app.firstWindow();
page.on('console', (m) => console.log(`[renderer:${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => console.log(`[renderer:error] ${e.message}`));
await page.waitForLoadState('domcontentloaded');
await page.setViewportSize({ width: 1280, height: 820 }).catch(() => {});
const targets = routes.length ? routes : [''];
for (const [i, route] of targets.entries()) {
  if (route)
    await page.evaluate((r) => {
      globalThis.location.hash = r.replace(/^#/, '');
    }, route);
  await page.waitForTimeout(Number(process.env.SHOT_WAIT ?? 1200));
  const file = path.join(outDir, `${String(i).padStart(2, '0')}-${route.replace(/[^a-z0-9]+/gi, '_') || 'home'}.png`);
  await page.screenshot({ path: file });
  console.log(`saved ${file}`);
}
await app.close();
