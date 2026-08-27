import { rm } from 'node:fs/promises';

const generatedPaths = [
  'apps/api/dist',
  'apps/web/dist',
  'apps/api/tsconfig.tsbuildinfo',
  'apps/web/tsconfig.tsbuildinfo',
];

for (const path of generatedPaths) await rm(path, { recursive: true, force: true });
