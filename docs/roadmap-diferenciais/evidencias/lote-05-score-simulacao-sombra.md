# Evidencia — Lote 05: score, simulacao e modo sombra

## Resultado

O motor de decisao agora calcula uma pontuacao deterministica, explica seus
componentes e compara a ordem sugerida com a fila atual sem alterar o caminho
critico. A ativacao continua opt-in por feature flag e o modo sombra e
assíncrono, com fallback operacional para a fila existente.

## Entregas

- migration `046_decision_engine.sql` com politicas versionadas, modos por
  campanha e decisoes consultaveis;
- `scoring.service.ts` puro, versionado e limitado a score de 0 a 1000;
- pesos padrao conservadores, hash da politica, autor e justificativa;
- motivos estruturados para prioridade, idade, inbound recente, callback,
  tentativas e fairness;
- simulacao com `eligibility`, `constraints`, `reasonCodes`, posicao FIFO e
  posicao sugerida;
- snapshot minimizado sem nome ou telefone;
- `DecisionShadowService` integrado ao tick sem `await` no caminho de reserva;
- deduplicacao por campanha/politica/lead/janela de um minuto;
- comparacao com delta medio, distribuicao por decisao e leads distintos;
- secao de campanha com politica, modo sombra, simulador e explicacao visual;
- verificador HTTP cobrindo versionamento, simulacao, modo, comparacao,
  registro sombra e ausencia de PII.

## Contratos

Endpoints entregues:

```text
GET  /api/tenants/:tenantId/campaigns/:campaignId/decision-policy
PUT  /api/tenants/:tenantId/campaigns/:campaignId/decision-policy
POST /api/tenants/:tenantId/campaigns/:campaignId/decision-policy/simulate
GET  /api/tenants/:tenantId/campaigns/:campaignId/decision-comparison
POST /api/tenants/:tenantId/campaigns/:campaignId/decision-mode
GET  /api/tenants/:tenantId/leads/:leadId/decision
```

O `DialerService` continua sendo dono da reserva atomica. O score sombra recebe
os mesmos candidatos, registra a posicao sugerida e nunca decide uma chamada.

## Verificacoes executadas

| Verificacao | Resultado |
| --- | --- |
| `npm run check:structure` | aprovado |
| `npm run typecheck` | aprovado |
| `npm test -- --runInBand` | 35 suites, 204 testes aprovados |
| `npm run test:web` | 14 arquivos, 33 testes aprovados |
| build local API A/B e web | aprovado |
| healthchecks locais `:3000` e `:3001` | saudaveis |
| `verify:campaign-execution` na API A | aprovado com politica v1/v2, simulacao, sombra, PII e playbook |
| `verify:campaign-execution` na API B | aprovado |
| `verify:multitenant` | aprovado |
| migration `046_decision_engine.sql` | aplicada no Postgres E2E |

O ambiente foi o Compose descartavel `zapliga-roadmap-e2e`, com Postgres na
porta local `55432`. Nenhum push, deploy, restart ou alteracao em producao foi
executado.
