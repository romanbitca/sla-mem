/**
 * Generates the app and tray icons from the SVG designs below, rendered by Electron itself (no
 * image tools needed). Run with: npm run icons   (macOS also builds build/icon.icns via iconutil)
 *
 * Output:
 *   build/icon.png                 1024 px app icon (electron-builder derives the Windows .ico)
 *   build/icon.icns                macOS app icon
 *   resources/tray/…               tray icons: macOS template images (@1x/@2x, idle and syncing)
 *                                  and colour PNGs for Windows
 *
 * The design is deliberately not Slack's logo (PLAN §9.2): an archive box with a chat bubble.
 */
const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const APP_ICON = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#5b76f4"/>
      <stop offset="1" stop-color="#2e44b2"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="14" stdDeviation="18" flood-color="#0b1440" flood-opacity="0.35"/>
    </filter>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="186" fill="url(#bg)"/>
  <g filter="url(#shadow)" fill="#ffffff">
    <rect x="258" y="292" width="508" height="124" rx="30"/>
    <path d="M296 440 H728 V672 a46 46 0 0 1 -46 46 H342 a46 46 0 0 1 -46 -46 Z"/>
  </g>
  <path fill="#3a55d0" d="M432 516 h160 a28 28 0 0 1 28 28 v56 a28 28 0 0 1 -28 28 h-82 l-44 38 v-38 h-34 a28 28 0 0 1 -28 -28 v-56 a28 28 0 0 1 28 -28 z"/>
</svg>`;

/** Monochrome box glyph for macOS menu-bar template images (black + alpha; the OS tints it). */
function trayGlyph({ color = '#000', syncing = false } = {}) {
  return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
  <defs>
    <mask id="cut">
      <rect width="16" height="16" fill="#fff"/>
      <rect x="6" y="8.4" width="4" height="1.6" rx="0.8" fill="#000"/>
      ${syncing ? '<circle cx="12.6" cy="3.4" r="3.4" fill="#000"/>' : ''}
    </mask>
  </defs>
  <g mask="url(#cut)" fill="${color}">
    <rect x="1.5" y="2.5" width="13" height="3.4" rx="1"/>
    <path d="M2.4 6.9 H13.6 V12.6 a1.4 1.4 0 0 1 -1.4 1.4 H3.8 a1.4 1.4 0 0 1 -1.4 -1.4 Z"/>
  </g>
  ${syncing ? `<circle cx="12.6" cy="3.4" r="2.3" fill="${color}"/>` : ''}
</svg>`;
}

/** Colour tray icon for Windows: the app icon's glyph on its blue tile, legible at 16 px. */
function windowsTray({ syncing = false } = {}) {
  return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
  <rect x="0.5" y="0.5" width="15" height="15" rx="3.5" fill="#3a55d0"/>
  <g fill="#fff">
    <rect x="3" y="3.6" width="10" height="2.6" rx="0.8"/>
    <path d="M3.7 7 H12.3 V11.3 a1.1 1.1 0 0 1 -1.1 1.1 H4.8 a1.1 1.1 0 0 1 -1.1 -1.1 Z"/>
  </g>
  <rect x="6.4" y="8.2" width="3.2" height="1.3" rx="0.65" fill="#3a55d0"/>
  ${syncing ? '<circle cx="12.8" cy="3.2" r="2.8" fill="#22c55e" stroke="#fff" stroke-width="0.9"/>' : ''}
</svg>`;
}

let win = null;

/** Renders `svg` at `size` px in one reused offscreen window (small sizes are drawn at 256 px and scaled down). */
async function render(svg, size, out) {
  const drawSize = Math.max(size, 256);
  if (!win) {
    win = new BrowserWindow({
      width: 1024,
      height: 1024,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      webPreferences: { offscreen: true },
    });
  }
  const html = `<!doctype html><html><head><style>html,body{margin:0;background:transparent}svg{display:block;width:${drawSize}px;height:${drawSize}px}</style></head><body>${svg}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 200));
  let image = await win.webContents.capturePage({ x: 0, y: 0, width: drawSize, height: drawSize });
  if (image.getSize().width !== size) image = image.resize({ width: size, height: size, quality: 'best' });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, image.toPNG());
}

async function main() {
  const build = path.join(ROOT, 'build');
  const tray = path.join(ROOT, 'resources', 'tray');
  await render(APP_ICON, 1024, path.join(build, 'icon.png'));

  if (process.platform === 'darwin') {
    const iconset = path.join(build, 'icon.iconset');
    fs.rmSync(iconset, { recursive: true, force: true });
    for (const s of [16, 32, 128, 256, 512]) {
      await render(APP_ICON, s, path.join(iconset, `icon_${s}x${s}.png`));
      await render(APP_ICON, s * 2, path.join(iconset, `icon_${s}x${s}@2x.png`));
    }
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(build, 'icon.icns')]);
    fs.rmSync(iconset, { recursive: true, force: true });
  }

  for (const [name, svg] of [
    ['trayTemplate', trayGlyph()],
    ['traySyncingTemplate', trayGlyph({ syncing: true })],
  ]) {
    await render(svg, 16, path.join(tray, `${name}.png`));
    await render(svg, 32, path.join(tray, `${name}@2x.png`));
  }
  for (const [name, svg] of [
    ['tray-win', windowsTray()],
    ['tray-win-syncing', windowsTray({ syncing: true })],
  ]) {
    await render(svg, 16, path.join(tray, `${name}.png`));
    await render(svg, 32, path.join(tray, `${name}@2x.png`));
  }
  win?.destroy();
  console.log('Icons written to build/ and resources/tray/');
}

app.disableHardwareAcceleration();
app
  .whenReady()
  .then(main)
  .then(() => app.quit())
  .catch((err) => {
    console.error(err);
    app.exit(1);
  });
