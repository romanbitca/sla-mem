import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Images may come from the archive's own files (archive:), data/blob URLs, and Slack's CDNs only:
 * the app talks to Slack and nothing else (PLAN §1.2). Third-party unfurl images are routed
 * through Slack's image proxy by the renderer (lib/remoteImage.ts).
 */
const IMG_SRC = "'self' data: blob: archive: https://*.slack-edge.com https://*.slack.com https://slack-imgs.com";

const PROD_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  `img-src ${IMG_SRC}`,
  'media-src archive:',
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

// Vite's dev client needs inline scripts (React refresh preamble) and a websocket for HMR.
const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  `img-src ${IMG_SRC}`,
  'media-src archive:',
  "font-src 'self' data:",
  "connect-src 'self' ws://localhost:* ws://127.0.0.1:*",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');

/** Injects the Content-Security-Policy meta tag (strict in builds, relaxed for the dev server). */
function contentSecurityPolicy(): Plugin {
  return {
    name: 'sla-mem:csp',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const policy = ctx.server ? DEV_CSP : PROD_CSP;
        return html.replace('<!-- CSP -->', `<meta http-equiv="Content-Security-Policy" content="${policy}" />`);
      },
    },
  };
}

export default defineConfig({
  main: {
    build: {
      rollupOptions: { input: { index: resolve('src/main/index.ts') } },
    },
  },
  preload: {
    build: {
      // Sandboxed preload scripts must be CommonJS and self-contained.
      rollupOptions: { input: { index: resolve('src/preload/index.ts') }, output: { format: 'cjs' } },
    },
  },
  renderer: {
    root: 'src/renderer',
    build: {
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } },
      minify: true,
    },
    plugins: [react(), tailwindcss(), contentSecurityPolicy()],
  },
});
