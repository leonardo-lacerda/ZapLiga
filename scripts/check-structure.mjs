import { access, readdir } from 'node:fs/promises';

const rootFiles = new Set([
  '.dockerignore', '.env.example', '.gitignore',
  'docker-compose.yml', 'package.json', 'package-lock.json', 'README.md',
]);
const entries = await readdir('.');
const unexpected = entries.filter((entry) => !rootFiles.has(entry) && entry !== 'apps' && entry !== 'node_modules' && entry !== 'scripts' && entry !== 'docs' && entry !== 'services' && entry !== 'backups' && entry !== 'Nova pasta' && entry !== '.git' && entry !== '.github' && entry !== '.claude' && entry !== '.tmp-zapliga-hosting');
if (unexpected.length) throw new Error(`Arquivos inesperados na raiz: ${unexpected.join(', ')}`);

for (const path of ['apps/api/src', 'apps/web/src', 'apps/landing']) {
  await access(path);
}

const expectedSourceEntries = {
  'apps/api/src': new Set(['app.module.ts', 'main.ts', 'database', 'infrastructure', 'modules', 'scripts']),
  'apps/web/src': new Set(['main.tsx', 'vite-env.d.ts', 'app', 'audio', 'components', 'features', 'services', 'shared', 'styles', 'types']),
  'apps/landing': new Set([
    'index.html', 'script.js', 'pages.js', 'styles.css', 'home.css',
    'boas-praticas-anti-bloqueio.html', 'carreiras.html', 'central-de-ajuda.html',
    'contato.html', 'guia-pool-numeros.html', 'lgpd.html', 'privacidade.html',
    'sobre.html', 'termos-de-uso.html',
  ]),
};
for (const [path, expected] of Object.entries(expectedSourceEntries)) {
  const actual = await readdir(path);
  const unexpectedSource = actual.filter((entry) => !expected.has(entry));
  if (unexpectedSource.length) throw new Error(`Arquivos inesperados em ${path}: ${unexpectedSource.join(', ')}`);
}

console.log('Estrutura do workspace válida.');
