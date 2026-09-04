# Evidência do Lote 10 — experiência de saúde e histórico

## Resultado

O score interno de saúde da operação agora é uma experiência navegável para o
líder, mantendo a distinção entre diagnóstico interno e qualquer regra oficial
do WhatsApp. A mesma superfície oferece visão geral, capacidade, tendência,
drilldown por linha e timeline de proteções automáticas e intervenções humanas.

## Entregas verificadas

- Card de saúde na visão geral, protegido pela flag `operation_health` e com
  atualização periódica.
- Rota dedicada `/app/saude-operacao`, com score, estado, componentes,
  denominadores, pesos, reason codes e próxima ação segura.
- Aviso explícito de que o score é interno do ZapLiga e não representa aprovação
  ou limite oficial do WhatsApp.
- Capacidade atual, chamadas ativas, fila pronta, callbacks vencidos e próxima
  liberação estimada.
- Histórico de snapshots persistidos e tendência visual.
- Seleção de linha com score individual, cooldown, quarentena, próxima liberação
  e timeline de eventos.
- Eventos automáticos de cooldown/quarentena sincronizados de forma idempotente.
- Intervenções humanas de proteção relacionadas a ações recomendadas, sem apagar
  a evidência operacional anterior.
- Preservação de recomendações de saúde durante a sincronização do catálogo.
- Fluxo de callback manual corrigido para respeitar o SDR atribuído e permitir
  somente callbacks vencidos, inclusive após reatribuição.

## Arquivos principais

- `apps/web/src/features/operation-health/OperationHealthPage.tsx`
- `apps/web/src/features/dashboard/OrganizerOverview.tsx`
- `apps/api/src/modules/operation-health/operation-health.service.ts`
- `apps/api/src/modules/operation-health/number-health.service.ts`
- `apps/api/src/modules/recommendations/recommendations.service.ts`
- `apps/api/src/modules/decision-engine/eligibility.service.ts`
- `apps/api/src/modules/dialer/dialer.service.ts`
- `apps/web/src/features/operation-health/OperationHealthPage.spec.tsx`

## Validação

Executado no ambiente Docker local descartável com fake Waxum determinístico:

- `npm run check:structure` — passou.
- `npm run typecheck` — passou.
- `npm test -- --runInBand` — 39 suítes, 218 testes passaram.
- `npm run test:web` — 15 arquivos, 35 testes passaram.
- `npm run test:e2e` — 14/14 jornadas passaram.
- `npm run verify:operation-health` — passou com snapshot, score e evento de
  linha retornados.
- `npm run verify:recommendations` — passou com recomendação tenant-scoped.
- `npm run verify:multitenant` — passou com autenticação, novas rotas, mismatch,
  quotas, IDOR, DTO, ticket e refresh rotativo.

O E2E foi repetido após a correção de ownership/due date do callback; a jornada
10 passou de ponta a ponta: callback vence, é reatribuído, inicia nova chamada e
é concluído no pós-atendimento.

Nenhum deploy, push ou alteração em produção foi executado. Os dados usados na
validação pertencem somente ao stack local `zapliga-roadmap-e2e`.
