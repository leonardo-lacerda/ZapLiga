import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { errorExplanations, stepLabels } from './provisioning.labels';

/**
 * Trava contra divergência de contrato: os códigos de erro e as etapas que o worker emite
 * (services/geelark-worker) precisam de texto na tela. Lê o código Python direto, então um
 * código ou etapa novo no worker sem rótulo aqui quebra o teste.
 */
const worker = (file: string) => readFileSync(resolve(__dirname, '../../../../../services/geelark-worker/app', file), 'utf8');
const all = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((match) => match[1]);

it('todo errorCode do worker tem explicação na tela', () => {
  const block = /ERROR_CODES = frozenset\(\{([\s\S]*?)\}\)/.exec(worker('errors.py'))?.[1] ?? '';
  const codes = all(block, /"([a-z_]+)"/g).filter((code) => code !== 'manual_takeover');
  expect(codes.length).toBeGreaterThan(10);
  expect(codes.filter((code) => !errorExplanations[code])).toEqual([]);
});

it('toda etapa que o worker emite tem rótulo na tela', () => {
  const jobs = worker('jobs.py');
  const steps = new Set([
    ...all(jobs, /_set_step\(job, "([a-z_]+)"/g),
    ...all(jobs, /step="([a-z_]+)"/g),
    ...all(jobs, /_wait_input\(job, ctx, "([a-z_]+)"/g),
    ...all(jobs, /_STEP = "([a-z_]+)"/g),
  ]);
  expect(steps.size).toBeGreaterThan(15);
  expect([...steps].filter((step) => !stepLabels[step])).toEqual([]);
});
