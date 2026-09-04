# Contratos e catálogos canônicos do roadmap

## Fonte executável

Os valores canônicos vivem em
`apps/api/src/modules/roadmap-contracts/roadmap-contracts.ts`. Este documento explica
o significado; código novo deve importar os tipos em vez de criar strings paralelas.

## Estados

- Campanha: `draft`, `ready`, `running`, `paused`, `completed`, `archived`.
- Decisão: `disabled`, `shadow`, `active`.
- Recomendação: `open`, `snoozed`, `dismissed`, `applied`, `resolved`, `expired`.
- Saúde: `insufficient_data`, `healthy`, `attention`, `degraded`, `blocked`.

## Reason codes

Reason codes descrevem fatos ou componentes de uma decisão. Eles nunca são a única
fonte de texto para o usuário e não carregam nome, telefone ou notas. O catálogo
inicial cobre agenda, supressão, tentativas, callbacks, recência, fairness, linha,
rate limit, SDR, campanha e amostra insuficiente.

## Eventos

Eventos usam `dominio.acao`, versão de contrato e IDs de correlação. O catálogo
inicial cobre ciclo da campanha, ingestão/elegibilidade do lead, decisão, chamada,
pós-atendimento, callback, etapa, saúde e recomendação.

## Evolução

- Valores publicados não mudam de significado.
- Renomear exige novo código e período de compatibilidade.
- Payloads ganham campos opcionais antes de torná-los obrigatórios.
- PII não entra no contrato analítico padrão.
- Mudança de semântica incrementa `ROADMAP_CONTRACT_VERSION`.
