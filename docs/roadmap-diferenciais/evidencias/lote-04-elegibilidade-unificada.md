# Evidência — Lote 04: elegibilidade unificada

## Resultado

As regras duras de seleção foram extraídas para um contrato único, puro e
testável. O mesmo avaliador agora é usado na seleção automática, na chamada
manual, no preview da fila, na simulação e na última revalidação antes de gravar
uma reserva.

## Contrato entregue

`evaluateLeadEligibility` retorna:

- `eligible` para a decisão final;
- `reasons` com `code` e `allowed` por regra;
- `reasonCodes` para explicação e telemetria;
- `blockedBy` deduplicado para o motivo acionável;
- `mode` e `checkedAt` para rastreabilidade.

Os modos são `automatic`, `manual`, `preview` e `simulation`. A chamada manual
mantém o override explícito de fila para rediscagem humana, mas nunca ignora
supressão, chamada ativa, campanha inválida, linha protegida, quarentena ou
self-call.

## Regras centralizadas

- pasta ativa e contato não suprimido;
- status de fila, limite de tentativas e `next_eligible_at`;
- callback pendente e ownership por SDR;
- campanha e janela de atendimento;
- SDR conectado/disponível quando exigido pelo modo;
- linha conectada, cooldown, proteção/quarentena e self-call;
- chamada ativa e revalidação transacional na reserva.

Também foi adicionado `GET /api/tenants/:tenantId/leads/:leadId/eligibility`,
protegido por autenticação, membership, role e flag `decision_engine`, para que
a explicação não fique restrita a logs internos.

## Arquivos principais

- `apps/api/src/modules/decision-engine/eligibility.service.ts`
- `apps/api/src/modules/decision-engine/eligibility.controller.ts`
- `apps/api/src/modules/decision-engine/eligibility.service.spec.ts`
- `apps/api/src/modules/decision-engine/decision-engine.module.ts`
- `apps/api/src/modules/dialer/dialer.service.ts`
- `apps/api/src/modules/roadmap-contracts/roadmap-contracts.ts`
- `scripts/verify-campaign-execution.mjs`

## Verificações executadas

| Verificação | Resultado |
| --- | --- |
| testes direcionados de elegibilidade e discador | 2 suítes, 30 testes aprovados |
| `npm run check:structure` | aprovado |
| `npm run typecheck` | aprovado |
| `npm test -- --runInBand` | 34 suítes, 200 testes aprovados |
| `npm run test:web` | 14 arquivos, 32 testes aprovados |
| build local das APIs | API A e API B compiladas |
| healthchecks locais `:3000` e `:3001` | saudáveis |
| `npm run verify:campaign-execution` | simulação permitida e supressão explicada |
| `npm run verify:campaign-lifecycle` | aprovado |
| `npm run verify:campaign-migration` | aprovado |
| `npm run verify:multitenant` | aprovado |

O ambiente foi o Compose descartável `zapliga-roadmap-e2e`, usando Postgres na
porta local `55432`. Nenhum push, deploy, restart ou alteração em produção foi
executado.
