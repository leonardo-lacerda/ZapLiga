# Plano 04 — Saúde da operação e camada de confiança

## Resultado desejado

Dar ao líder uma leitura única e auditável da capacidade de operar com segurança,
reunindo saúde das linhas, ritmo, falhas, fila, SDRs, integrações e compliance.

## Base existente

O projeto já implementa cooldown, janela móvel por linha, limite global de ritmo,
quarentena por quedas rápidas, tratamento de 429, histórico de status, agenda,
supressão e auditoria. A vantagem está em transformar essas proteções internas em
um produto compreensível, sem apresentar limites locais como garantia oficial do
WhatsApp.

## Modelo de saúde

Exibir dois níveis:

- **Estado:** saudável, atenção, degradado ou bloqueado.
- **Score interno:** 0 a 100, acompanhado dos componentes e da metodologia.

O estado manda mais que o score. Uma supressão, ausência de consentimento quando
exigido ou bloqueio operacional não pode ser compensado por boa performance.

## Componentes iniciais

| Componente | Sinais | Peso inicial sugerido |
| --- | --- | ---: |
| conectividade das linhas | sessões conectadas e reconexões | 25 |
| estabilidade de chamadas | falhas, quedas rápidas e 429 | 25 |
| capacidade disponível | cooldown, quarentena e concorrência | 15 |
| prontidão da equipe | SDRs conectados, disponíveis e wrap-up | 15 |
| qualidade da fila | leads elegíveis, callbacks e tentativas | 10 |
| conformidade | agenda, supressão e rastreabilidade | 10 |

Os pesos são configuração de produto versionada, não configuração livre do cliente
no MVP. O painel deve mostrar denominador e tamanho da amostra.

## Modelo de dados

### Migration proposta: `045_operation_health.sql`

Criar `operation_health_snapshots`:

- `tenant_id`, `campaign_id` opcional e timestamp;
- estado e score geral;
- scores por componente;
- reason codes e contagens agregadas;
- versão da fórmula.

Criar `number_health_events` para eventos que hoje ficam apenas em logs ou colunas:

- conexão, desconexão, reconexão;
- cooldown iniciado/finalizado;
- quarentena iniciada/finalizada;
- 429, queda rápida e chamada com mídia;
- alteração manual de proteção.

Não duplicar `number_status_history`; usá-lo como fonte e armazenar apenas eventos
ausentes ou uma projeção normalizada.

## Backend

Criar `apps/api/src/modules/operation-health/`:

- `health-formula.ts`, pura e versionada;
- `operation-health.service.ts`;
- `number-health.service.ts`;
- job de snapshots com lock distribuído;
- adaptador para recomendações.

Endpoints:

```text
GET /api/tenants/:tenantId/operation-health
GET /api/tenants/:tenantId/operation-health/history
GET /api/tenants/:tenantId/numbers/:numberId/health
GET /api/tenants/:tenantId/numbers/:numberId/health/events
```

O endpoint deve explicar:

- score e estado;
- componentes;
- evidência atual;
- tendência;
- bloqueios invioláveis;
- próxima ação segura;
- data e versão da fórmula.

## Frontend

- Card persistente de saúde na visão geral.
- Página `Saúde da operação` com visão geral e drilldown por linha.
- Linha do tempo de eventos por número.
- Explicação “por que está em atenção?”.
- Capacidade disponível agora e próxima liberação estimada.
- Selo claro de “score interno do ZapLiga”, sem alegar aprovação do WhatsApp.
- Configurações de proteção continuam na área do discador e números.

## Compliance como restrição de primeira classe

- Supressão ativa sempre bloqueia discagem.
- Agenda é avaliada no timezone da empresa.
- Consentimento e origem ficam consultáveis no lead.
- Retirada de supressão exige papel permitido, justificativa e auditoria.
- Recomendações nunca sugerem remover proteção para aumentar volume.
- Exportações e snapshots não incluem telefone em claro sem necessidade.

## Fases

### Fase 1 — telemetria confiável

- Catalogar reason codes e fechar lacunas de eventos.
- Validar relógios, transições e reinícios.

### Fase 2 — fórmula e endpoint

- Calcular score em tempo real e testar cenários sintéticos.
- Expor versão e componentes.

### Fase 3 — experiência visual

- Visão geral, drilldown e timeline.
- Conectar riscos ao Plano 03.

### Fase 4 — histórico e tendência

- Persistir snapshots agregados.
- Comparar estabilidade antes/depois de mudanças de ritmo.

## Critérios de aceite

- [ ] O mesmo snapshot produz o mesmo score para a mesma versão da fórmula.
- [ ] Todo estado degradado possui ao menos um motivo verificável.
- [ ] Bloqueios de compliance não podem ser compensados pelo score.
- [ ] Reiniciar a API não apaga cooldown, quarentena ou evidência necessária.
- [ ] A timeline distingue evento automático de intervenção humana.
- [ ] Nenhuma tela apresenta limites internos como regra oficial do WhatsApp.
- [ ] Cálculo, histórico e endpoints são isolados por tenant.
- [ ] Testes cobrem desconexão, 429, queda rápida, cooldown e recuperação.

## Métricas

- tempo em cada estado de saúde;
- incidentes por 100 tentativas;
- taxa de reconexão e tempo para recuperação;
- concentração de chamadas e falhas por linha;
- operações bloqueadas por compliance;
- recorrência após intervenção;
- percentual de chamadas iniciadas dentro das políticas vigentes.

## Riscos

- Um score pode transmitir precisão falsa: sempre mostrar componentes e amostra.
- Eventos incompletos distorcem saúde: exibir estado “dados insuficientes”.
- Incentivo comercial pode pressionar limites: tornar proteções não compensáveis.
