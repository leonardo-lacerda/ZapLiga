import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const landingPage = resolve(__dirname, '../../index.html');
const landingScript = resolve(__dirname, '../../script.js');
const landingStyles = resolve(__dirname, '../../styles.css');

const landingDevServer = (): Plugin => ({
  name: 'zapliga-landing-dev-server',
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const path = request.url?.split('?', 1)[0];
      const files: Record<string, { path: string; type: string }> = {
        '/': { path: landingPage, type: 'text/html; charset=utf-8' },
        '/index.html': { path: landingPage, type: 'text/html; charset=utf-8' },
        '/script.js': { path: landingScript, type: 'application/javascript; charset=utf-8' },
        '/styles.css': { path: landingStyles, type: 'text/css; charset=utf-8' },
      };
      const file = path ? files[path] : undefined;
      if (!file) return next();
      response.statusCode = 200;
      response.setHeader('Content-Type', file.type);
      response.end(readFileSync(file.path));
    });
  },
});

export default defineConfig({ base: '/app/', plugins: [react(), landingDevServer()] });
