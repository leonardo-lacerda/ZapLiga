# Evidência — Lote 14: benchmarks privados

## Status

Em andamento. A infraestrutura implementável está pronta localmente em
2026-09-04, sem Docker, mas o lote permanece aberto até as dependências externas
serem aprovadas.

## Entregas implementadas

- Migration `053_private_benchmarks.sql` com eventos de consentimento,
  revogação, execuções de coorte e agregados sem `tenant_id`, `lead_id`, telefone,
  nome ou texto livre.
- Consentimento versionado por finalidade, com histórico append-only e auditoria
  para opt-in e opt-out.
- Opt-in fechado por `BENCHMARK_CONSENT_APPROVED=true` até o texto jurídico e a
  finalidade serem aprovados formalmente.
- Opt-out considera somente o evento mais recente e bloqueia novos processamentos
  compartilhados para o tenant.
- Formação de coortes por porte de equipe e faixa de volume, exigindo mínimo
  configurável de tenants e chamadas por tenant.
- Percentis p25/mediana/p75 e média aparada, sem ranking nominal ou retorno de
  identificadores de empresas.
- Inspeção interna para `super_admin` e refresh persistido de agregados com
  retenção configurável (`BENCHMARK_AGGREGATE_RETENTION_DAYS`, padrão 30 dias).
- UI `/app/benchmarks` atrás da flag `benchmarks`, com explicação de privacidade,
  consentimento, revogação, metodologia e bloqueio por aprovação jurídica ou
  amostra insuficiente.

## Dependências externas que mantêm o lote aberto

- texto jurídico e finalidade de uso aprovados;
- definição formal do mínimo de tenants por coorte;
- volume real suficiente para formar coortes;
- revisão de uma amostra real pelos responsáveis de privacidade/jurídico.

Enquanto essas dependências não forem aprovadas, o benchmark permanece invisível
por padrão e o switch de release impede opt-in e processamento compartilhado.

## Validação local

```text
npm run check:structure                         PASS
npm run typecheck                               PASS
npm --workspace apps/api run test -- benchmarks.service.spec.ts --runInBand  PASS — 3 testes
npm --workspace apps/web run test -- src/features/benchmarks/BenchmarksPage.spec.tsx  PASS — 1 teste
```

Não houve execução de migration, refresh ou E2E contra banco nesta rodada para
manter o desenvolvimento sem Docker e não simular aprovação/volume que ainda não
existem.
