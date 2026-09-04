# Evidência do Lote 00 — baseline, contratos e trilhos

Data da validação: 2026-09-04  
Base de comparação: `ab72f45`  
Escopo: ambiente local isolado; nenhuma ação foi executada em produção.

## Resultado

O Lote 00 está aprovado. As sete capacidades do roadmap possuem flags tenant-scoped,
nascem desativadas, preservam o comportamento legado e podem ser alteradas pelo
endpoint administrativo já auditado. O catálogo canônico, a fixture multitenant, a
matriz de compatibilidade e a decisão de precedência foram registrados.

Durante o primeiro E2E, a combinação entre DTO e campos opcionais revelou que
propriedades ausentes chegavam como `undefined` e poderiam violar o `NOT NULL` das
novas colunas. O serviço agora descarta valores não booleanos antes do merge; existe
teste unitário de regressão e o E2E final passou.

## Baseline reproduzível

Antes do Lote 00:

- backend: 28 suítes e 173 testes aprovados;
- frontend: 12 arquivos e 23 testes aprovados;
- typecheck: aprovado;
- `check:structure`: reprovava exclusivamente porque `.env`, orientado pelo README e
  ignorado pelo Git, não constava na allowlist do verificador.

Após o Lote 00:

- backend: 29 suítes e 177 testes aprovados;
- frontend: 12 arquivos e 23 testes aprovados;
- typecheck: aprovado;
- build completo: aprovado, 327 módulos web transformados;
- estrutura: aprovada após alinhar a allowlist ao contrato documentado de `.env`;
- smoke multitenant: aprovado;
- Playwright: 12 de 12 jornadas críticas aprovadas em 28,2 segundos;
- healthcheck da API e aplicação web: HTTP 200.

Comandos locais usados:

```powershell
npm --workspace apps/api test -- --runInBand
npm --workspace apps/web test
npm run typecheck
npm run check:structure
npm run build
```

O E2E foi executado com o projeto Compose descartável
`zapliga-roadmap-e2e`, em portas 55432, 56379, 54222, 58222, 53451, 53000
e 55173, para não interferir em stacks locais existentes. Os comandos de validação
foram:

```powershell
$env:SMOKE_API_URL='http://127.0.0.1:53000'
$env:DATABASE_URL='postgres://zapcall:zapcall@127.0.0.1:55432/zapcall'
npm run verify:multitenant

$env:E2E_API_URL='http://127.0.0.1:53000'
$env:E2E_WEB_URL='http://127.0.0.1:55173'
npm run test:e2e
```

## Flags e compatibilidade

A migration `042_defensible_roadmap_feature_flags.sql` foi aplicada no banco vazio.
As flags `campaigns`, `decision_engine`, `recommendations`, `operation_health`,
`analytics_learning`, `experiments` e `benchmarks` foram observadas como `false` em
todas as seis linhas geradas pelos testes.

O E2E verifica que:

1. um tenant novo recebe todas as flags do roadmap desligadas;
2. habilitar apenas capacidades legadas não habilita nenhuma capacidade nova;
3. o endpoint administrativo continua funcional e registra auditoria;
4. as 12 jornadas legadas permanecem verdes.

A compatibilidade detalhada está em `../matriz-compatibilidade-flags.md`.

## Consultas críticas

As medições abaixo foram feitas com `EXPLAIN (ANALYZE, BUFFERS)` no banco E2E. Como
o conjunto é pequeno, os tempos validam a forma da consulta e o uso dos índices, não
representam capacidade ou latência de produção.

| Caminho | Plano observado | Tempo de execução |
| --- | --- | ---: |
| seleção de linha elegível por tenant | bitmap index scan em `whatsapp_numbers_tenant_status_idx` | 0,122 ms |
| seleção da fila de leads por tenant | index scan em `leads_tenant_queue_priority_idx` | 0,131 ms |
| leitura de flags por tenant | index scan na PK `tenant_feature_flags_pkey` | 0,027 ms |

O catálogo também confirmou índices tenant-scoped para chamadas, callbacks, pastas,
leads, linhas e flags. Lotes posteriores devem comparar alterações nos caminhos de
tick, reserva e dashboard contra esta referência, usando volume representativo antes
de aceitar conclusão sobre performance.

## Métricas operacionais

O endpoint autenticado `/internal/metrics` respondeu HTTP 200 após o E2E. Foram
observados contadores para chamadas iniciadas e bloqueadas por agenda, sucesso/falha
de autenticação, acesso com sessão revogada e callbacks; summaries para jornadas de
callback, privacidade, chamada, convites, autenticação, entrega de e-mail e tempo até
primeira chamada; e gauge de callbacks vencidos.

Snapshot do ambiente de teste ao final da execução:

- `calls_started_total`: 4;
- `calls_blocked_schedule_total`: 2;
- `login_success_total`: 16;
- `callbacks_created_total`: 2;
- `callbacks_overdue`: 0.

Os valores são efeitos acumulados das execuções E2E locais e servem apenas para
provar emissão e leitura das métricas. Nenhuma métrica expôs telefone, nota ou segredo.

## Artefatos do gate

- ADR de precedência: `../../adr/006-precedencia-roadmap-e-rollout.md`;
- catálogo canônico: `../contratos-catalogos.md` e módulo
  `apps/api/src/modules/roadmap-contracts`;
- fixture isolada com dois tenants: `roadmap-fixtures.ts`;
- matriz de compatibilidade: `../matriz-compatibilidade-flags.md`;
- migration e serviço de flags: módulo `feature-flags`.

## Gates

- Q1 — testes unitários e integração: aprovado;
- Q2 — tipos, lint estrutural e build: aprovado;
- Q4 — smoke multitenant e E2E: aprovado;
- comportamento legado com flags desligadas: aprovado;
- rollout em produção: não realizado e fora do escopo desta validação.
