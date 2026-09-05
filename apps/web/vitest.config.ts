import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({ plugins: [react()], test: { globals: true, environment: 'jsdom', setupFiles: ['./src/test/setup.ts'], restoreMocks: true, clearMocks: true, testTimeout: 10_000, exclude: ['e2e/**', 'node_modules/**', 'dist/**'] } });
