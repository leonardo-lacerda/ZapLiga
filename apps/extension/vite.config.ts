import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import pkg from './package.json' with { type: 'json' };

// The same API the web app talks to. Build against another one (a local stack) with
// ZAPLIGA_API_URL=http://127.0.0.1:3000 npm run build.
const apiUrl = (process.env.ZAPLIGA_API_URL ?? 'https://api.zapliga.com').replace(/\/+$/, '');
const webUrl = (process.env.ZAPLIGA_WEB_URL ?? 'https://zapliga.com/app').replace(/\/+$/, '');
const apiOrigin = new URL(apiUrl).origin;
const local = !apiUrl.startsWith('https://api.zapliga.com');

const manifest = {
  manifest_version: 3,
  name: local ? `ZapLiga (teste ${new URL(apiUrl).host})` : 'ZapLiga',
  short_name: 'ZapLiga',
  description: 'Ligue pelo WhatsApp do ZapLiga direto do canto do navegador.',
  version: pkg.version,
  minimum_chrome_version: '116',
  icons: { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' },
  action: { default_title: 'Mostrar/esconder o ZapLiga', default_icon: { 16: 'icons/16.png', 32: 'icons/32.png' } },
  background: { service_worker: 'background.js', type: 'module' },
  // offscreen: the call (microphone, speaker, control channel) lives there, so it survives page
  // navigations and closing the floating window. scripting: show the window in tabs that were
  // already open when the extension was installed.
  permissions: ['offscreen', 'storage', 'scripting'],
  host_permissions: [`${apiOrigin}/*`, '<all_urls>'],
  content_scripts: [{ matches: ['http://*/*', 'https://*/*'], js: ['content.js'], run_at: 'document_idle', all_frames: false }],
  web_accessible_resources: [{ resources: ['panel.html', 'assets/*'], matches: ['http://*/*', 'https://*/*'] }],
  content_security_policy: { extension_pages: `script-src 'self'; object-src 'self'; connect-src 'self' ${apiOrigin} ${apiOrigin.replace(/^http/, 'ws')}` },
};

// --- Icons: a filled circle in the ZapLiga blue, written as PNG without any image library. ---
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buffer: Buffer) => { let c = 0xffffffff; for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([len, body, crc]); };
const iconPng = (size: number) => {
  const rows: Buffer[] = [];
  const r = size / 2;
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x += 1) {
      const dx = x + 0.5 - r; const dy = y + 0.5 - r; const d = Math.sqrt(dx * dx + dy * dy);
      const alpha = Math.max(0, Math.min(1, r - d));
      // White handset-ish bar across the middle, slanted: a simple recognisable mark.
      const inMark = Math.abs((dx - dy) / Math.SQRT2) < size * 0.11 && Math.abs((dx + dy) / Math.SQRT2) < size * 0.3;
      const [cr, cg, cb] = inMark ? [255, 255, 255] : [7, 139, 232];
      row.set([cr, cg, cb, Math.round(alpha * 255)], 1 + x * 4);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
};

const extensionFiles = (): Plugin => ({
  name: 'zapliga-extension-files',
  writeBundle(options) {
    const out = options.dir!;
    writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
    mkdirSync(resolve(out, 'icons'), { recursive: true });
    for (const size of [16, 32, 48, 128]) writeFileSync(resolve(out, `icons/${size}.png`), iconPng(size));
  },
});

export default defineConfig({
  root: resolve(__dirname, 'src'),
  base: '',
  plugins: [react(), extensionFiles()],
  resolve: { alias: { '@web': resolve(__dirname, '../web/src') } },
  define: {
    'import.meta.env.VITE_API_URL': JSON.stringify(apiUrl),
    __ZAPLIGA_WEB_URL__: JSON.stringify(webUrl),
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    // Extension pages may not run eval/inline code; keep the output readable for review.
    minify: false,
    modulePreload: false,
    target: 'chrome116',
    rollupOptions: {
      input: {
        panel: resolve(__dirname, 'src/panel.html'),
        offscreen: resolve(__dirname, 'src/offscreen.html'),
        permission: resolve(__dirname, 'src/permission.html'),
        background: resolve(__dirname, 'src/background.ts'),
        content: resolve(__dirname, 'src/content.ts'),
      },
      output: {
        // background.js / content.js must sit at fixed names; content.js may not import chunks.
        entryFileNames: (chunk) => (chunk.name === 'background' || chunk.name === 'content' ? '[name].js' : 'assets/[name]-[hash].js'),
      },
    },
  },
});
