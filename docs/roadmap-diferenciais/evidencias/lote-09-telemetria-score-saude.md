# Evidência do Lote 09 — telemetria e score de saúde

O Lote 09 implementa a primeira fatia vertical da saúde operacional: sinais
agregados, fórmula pura e versionada, snapshots persistidos, timeline por linha e
integração opcional com recomendações de risco.

## Entregas

- migration `048_operation_health.sql` com `operation_health_snapshots` e
  `number_health_events` tenant-scoped;
- `health-formula.ts` com a versão `v1`, score 0–100, componentes ponderados,
  amostra, reason codes, bloqueios não compensáveis e estado `insufficient_data`;
- `OperationHealthService` com coleta das últimas 24h, agenda no timezone do
  tenant, capacidade, equipe, fila, compliance e snapshots limitados a um por
  minuto;
- job periódico de snapshots com lock distribuído no Redis;
- `NumberHealthService` com cooldown, quarentena, 429, quedas rápidas e
  normalização idempotente de `number_status_history` em timeline automática;
- endpoints protegidos por autenticação, membership, papel de liderança e flag
  `operation_health`;
- adaptador que alimenta `operation_recommendations` somente quando a flag de
  recomendações também está ativa, sem telefone, e-mail ou segredo na evidência.

## Verificações

Executado no stack descartável `zapliga-roadmap-e2e`:

```text
39 suites de API / 217 testes — passou
14 arquivos web / 34 testes — passou
check:structure + typecheck API/Web — passou
verify:operation-health — passou
health API A/B — passou
```

O verificador confirmou: flag desligada retorna `409`; a flag ligada expõe score,
componentes, fórmula e amostra; o histórico mantém o snapshot após recriação das
APIs; uma linha conectada produz evento `reconnected` com `actorType=automatic`;
e um cenário com baixa prontidão alimenta recomendação de risco com fonte
`operation_health`.

## Limites explícitos

O score é uma heurística interna do ZapLiga e não representa aprovação, limite ou
garantia oficial do WhatsApp. Eventos manuais serão adicionados pelos comandos de
intervenção da experiência do Lote 10; a infraestrutura já distingue
`automatic` de `human` no contrato.
