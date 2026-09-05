# Evidência do Lote 11 — contrato analítico, outbox e webhooks

## Resultado

O ZapLiga agora possui um contrato analítico versionado e tenant-scoped para
eventos operacionais, com persistência idempotente, outbox transacional,
publicação durável em JetStream, recibos idempotentes e reconciliação de
qualidade. O mesmo pipeline alimenta outbound webhooks com assinatura,
retry e dead-letter.

## Entregas verificadas

- `analytics-events.catalog.ts` define o catálogo v1 e os campos permitidos
  por evento. Campos desconhecidos, texto livre, nomes, telefones e outros
  dados fora do contrato são descartados antes da persistência.
- `analytics_events` usa chave de idempotência por tenant; cada evento cria
  uma entrada em `analytics_event_outbox` na mesma transação. O publicador
  usa `msgID` do evento no JetStream e o consumidor grava
  `analytics_event_receipts` de forma idempotente.
- A reconciliação compara chamadas de origem com `call.ended`, calcula
  cobertura, eventos inválidos, futuros e fora de ordem, divergência de
  rollup, pendências do outbox e atraso médio de publicação
  (`outboxDelaySeconds`). O resultado registra a fórmula v1, score, status e
  os detalhes auditáveis.
- Decisões ativas e shadow publicam `decision.scored`; decisões ativas também
  publicam `decision.selected`, sempre com chaves idempotentes e somente com
  score, versão de política e reason codes.
- Endpoints outbound aceitam HTTPS (ou loopback local para desenvolvimento),
  armazenam apenas segredo cifrado, assinam o corpo com HMAC, enviam
  idempotency key e aplicam retry exponencial até dead-letter.
- Falhas no pipeline analítico são absorvidas pelas integrações de campanha,
  saúde, recomendações e decisão; a operação principal continua disponível.

## Critérios do lote

- [x] Evento duplicado não altera o evento original, o outbox ou o efeito
  externo.
- [x] Indisponibilidade analítica não bloqueia a chamada.
- [x] Divergência é rastreável até eventos, período e versão da fórmula.
- [x] PII desnecessária não entra no contrato analítico.
- [x] Webhook possui assinatura, idempotência, retry e dead-letter.
- [x] Isolamento por tenant é aplicado nas rotas e nas chaves compostas do
  banco.

## Validação local

Gates executados no stack descartável `zapliga-roadmap-e2e`, sem alteração em
produção:

- `npm run check:structure`
- `npm run typecheck`
- `npm test -- --runInBand`
- `npm run test:web`
- `npm run test:e2e` — 14/14 cenários
- `npm run verify:analytics-events`
- health checks dos dois processos da API após build local
- migrações 049 e 050 aplicadas no Postgres local

Os testes unitários cobrem sanitização, idempotência do evento, fórmula de
confiabilidade e contratos de webhook. O verificador HTTP cobre flag,
catálogo, evento sanitizado, reconciliação, outbox, segredo exibido somente na
criação e limpeza tenant-scoped.

## Próxima etapa

O Lote 11 está concluído localmente. O próximo lote implementa agregados
históricos por tenant, amostra mínima, suavização e insights consumidos apenas
em modo shadow.
