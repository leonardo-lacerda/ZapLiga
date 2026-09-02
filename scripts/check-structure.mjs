import { access, readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';

const rootFiles = new Set([
  '.dockerignore', '.env.example', '.gitignore',
  'docker-compose.yml', 'docker-compose.e2e.yml', 'package.json', 'package-lock.json', 'README.md',
  'AGENTS.md', 'CLAUDE.md',
]);
const entries = await readdir('.');
const allowedDirectories = new Set([
  'apps', 'node_modules', 'scripts', 'docs', 'services', 'backups', 'infra',
  'output', 'tmp', 'Nova pasta', '.git', '.github', '.claude', '.tmp-zapliga-hosting',
]);
const isTemporaryDeployArtifact = (entry) => entry.startsWith('.deploy-') || entry === '.tmp-waxum-diagnostics';
const unexpected = entries.filter((entry) => (
  !rootFiles.has(entry) && !allowedDirectories.has(entry) && !isTemporaryDeployArtifact(entry)
));
if (unexpected.length) throw new Error(`Arquivos inesperados na raiz: ${unexpected.join(', ')}`);

for (const path of ['apps/api/src', 'apps/web/src', 'apps/landing']) {
  await access(path);
}

const expectedSourceEntries = {
  'apps/api/src': new Set(['app.module.ts', 'main.ts', 'database', 'infrastructure', 'modules', 'scripts']),
  'apps/web/src': new Set(['main.tsx', 'vite-env.d.ts', 'app', 'audio', 'components', 'features', 'services', 'shared', 'styles', 'test', 'types']),
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

const textExtensions = new Set(['.css', '.html', '.js', '.jsx', '.json', '.md', '.mjs', '.sql', '.ts', '.tsx']);
const corruptedText = [
  { label: 'caractere de substituição Unicode', expression: /\uFFFD/u },
  { label: 'texto UTF-8 interpretado como Latin-1', expression: /(?:\u00C3|\u00C2|\u00E2)[\u0080-\u00BF]/u },
];

async function findEncodingIssues(path) {
  const issues = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name === 'test-results') continue;
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) {
      issues.push(...await findEncodingIssues(entryPath));
      continue;
    }
    if (!textExtensions.has(extname(entry.name))) continue;
    const contents = await readFile(entryPath, 'utf8');
    for (const pattern of corruptedText) {
      const match = pattern.expression.exec(contents);
      if (!match) continue;
      const line = contents.slice(0, match.index).split(/\r?\n/u).length;
      issues.push(`${entryPath}:${line} (${pattern.label})`);
    }
  }
  return issues;
}

const encodingIssues = await findEncodingIssues('apps');
if (encodingIssues.length) throw new Error(`Textos com codificação corrompida:\n${encodingIssues.join('\n')}`);

console.log('Estrutura do workspace válida.');
