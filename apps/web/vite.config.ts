import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { resolve, extname, normalize } from 'node:path';

// The public marketing/legal site (apps/landing) is plain static HTML/JS/CSS
// with no build step. Production serves it as-is via nginx (see Dockerfile);
// this mirrors that in dev so every page under apps/landing is reachable at
// the same bare filename, not just the handful this used to hardcode.
const landingDir = resolve(__dirname, '../landing');
const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const landingDevServer = (): Plugin => ({
  name: 'zapliga-landing-dev-server',
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const path = request.url?.split('?', 1)[0];
      if (!path || path.startsWith('/app/')) return next();
      const relative = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
      const type = contentTypes[extname(relative)];
      if (!type) return next();
      const filePath = normalize(resolve(landingDir, relative));
      if (!filePath.startsWith(landingDir)) return next();
      let contents: Buffer;
      try { contents = readFileSync(filePath); } catch { return next(); }
      response.statusCode = 200;
      response.setHeader('Content-Type', type);
      response.end(contents);
    });
  },
});

export default defineConfig({ base: '/app/', plugins: [react(), landingDevServer()] });
