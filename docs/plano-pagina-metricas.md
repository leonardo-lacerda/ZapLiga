# Plano completo de implementação — Página de Métricas da Organização

## 1. Objetivo

Criar uma área analítica completa para líderes e organizadores acompanharem a operação comercial do ZapLiga, transformando os dados de chamadas, leads, SDRs, pastas e números em decisões acionáveis.

A página deve responder, com rastreabilidade:

- qual é o volume e a tendência da operação;
- quantos leads únicos foram trabalhados;
- qual é a taxa de atendimento e de avanço no funil;
- quais SDRs, pastas, horários e números performam melhor;
- onde existem gargalos operacionais;
- quais ações devem ser tomadas;
- como o resultado atual se compara com metas e períodos anteriores.

## 2. Diretriz de produto

Separar claramente duas experiências:

1. **Visão geral:** operação em tempo real, fila, discador, chamadas ativas e saúde imediata.
2. **Métricas:** análise histórica, comparação, diagnóstico, metas, alertas, relatórios e exploração detalhada.

A nova área será acessível somente para `leader` e `super_admin`. SDR não deve visualizar métricas consolidadas da organização; poderá futuramente ter uma visão individual limitada.

## 3. Escopo final

### 3.1 Análise histórica

- volume de chamadas por período;
- leads únicos trabalhados;
- tentativas por lead;
- chamadas atendidas;
- taxa de atendimento;
- chamadas concluídas, canceladas, sem resposta e com falha;
- duração média, mediana e total;
- resultados comerciais;
- avanço entre etapas do funil;
- preenchimento do pós-atendimento;
- comparação com período anterior;
- análise por dia, hora, SDR, pasta, número e origem.

### 3.2 Acompanhamento em tempo real

- chamadas em andamento;
- SDRs disponíveis, em chamada, em pós-atendimento e offline;
- leads prontos e aguardando horário;
- números conectados, indisponíveis, em cooldown ou em quarentena;
- alerta de fila parada;
- atualização automática com indicação de horário da última atualização.

### 3.3 Gestão e planejamento

- metas da organização;
- metas por SDR;
- metas por pasta;
- acompanhamento semanal e mensal;
- alertas configuráveis;
- relatórios salvos;
- exportações filtradas;
- relatórios periódicos;
- trilha de auditoria das alterações de metas e configurações.

## 4. Métricas e definições oficiais

Antes da implementação visual, as definições abaixo devem ser documentadas no backend e exibidas na interface por tooltip ou painel de ajuda.

| Métrica | Definição | Observação |
| --- | --- | --- |
| Chamadas realizadas | Registros de `calls` criados no período | Inclui chamadas automáticas e manuais, com filtro de origem |
| Leads únicos trabalhados | `COUNT(DISTINCT lead_id)` no período | Evita confundir tentativas com pessoas |
| Atendidas | Chamadas com `connected_at IS NOT NULL` | É a definição já usada no status atual |
| Taxa de atendimento | Atendidas ÷ chamadas realizadas | Exibir também o denominador |
| Tentativas médias por lead | Chamadas ÷ leads únicos trabalhados | Exibir somente quando houver leads |
| Tempo conectado | Soma do tempo de conversa | Deve ser separado do tempo de toque |
| Duração média | Tempo conectado ÷ chamadas atendidas | Não misturar chamadas não atendidas |
| Taxa de pós-atendimento | Chamadas atendidas com `wrap_up_completed_at` ÷ chamadas atendidas | Mede qualidade do registro |
| Avanço de etapa | Leads que mudaram de etapa no período | Exige histórico de etapas, não apenas o estado atual |
| Resultado positivo | Resultados classificados como positivos no catálogo da organização | Não inferir a partir de texto livre |
| Conversão | Resultado ou etapa definida como conversão pela organização | Deve ser configurável |
| Utilização do SDR | Tempo em chamada ou pós-atendimento ÷ tempo disponível monitorado | Exige histórico de presença/disponibilidade |
| Capacidade do número | Chamadas simultâneas atuais ÷ limite configurado | Indicador operacional, não comercial |

### 4.1 Regras de interpretação

- `completed` é status técnico da chamada, não necessariamente conversão comercial.
- `call_result` e `pipeline_stage` são dimensões comerciais e devem ser analisados separadamente.
- Chamadas manuais devem ser identificáveis por `source` e não devem consumir o orçamento de tentativas automáticas.
- Métricas históricas devem usar o evento ocorrido no período, não somente o estado atual do lead.
- Todo percentual deve mostrar quantidade absoluta de origem e denominador.
- Períodos devem respeitar o timezone configurado para a organização.
- Períodos sem dados devem retornar zero, não `null`, e informar que não houve atividade.

## 5. Arquitetura da experiência

### 5.1 Navegação

Adicionar um item `Métricas` no grupo `Operação`, entre `Visão geral` e `Leads`.

Nova chave de navegação:

```ts
type TabKey = 'dashboard' | 'metrics' | 'numbers' | 'leads' | 'sdrs' | 'calls' | 'access' | 'admin';
```

Novo domínio frontend:

```text
apps/web/src/features/metrics/
├── MetricsPage.tsx
├── MetricsFilters.tsx
├── MetricsKpiGrid.tsx
├── ActivityTrendChart.tsx
├── FunnelChart.tsx
├── OutcomeBreakdown.tsx
├── SdrPerformanceTable.tsx
├── FolderPerformanceTable.tsx
├── NumberHealthTable.tsx
├── MetricsAlerts.tsx
├── MetricsGoals.tsx
├── MetricDetailDrawer.tsx
├── SavedViewsPanel.tsx
└── metrics.types.ts
```

### 5.2 Estrutura da página

1. Cabeçalho com título, período, comparação, atualização e exportação.
2. Barra de filtros globais.
3. Cards principais de KPI.
4. Alertas e anomalias relevantes.
5. Gráfico de evolução da atividade.
6. Funil de leads e chamadas.
7. Distribuição de resultados e etapas.
8. Desempenho por SDR.
9. Desempenho por pasta.
10. Saúde dos números.
11. Heatmap de horários.
12. Metas e progresso.
13. Rodapé com fonte, timezone e horário da atualização.

## 6. Funcionalidades de interface

### 6.1 Filtros globais

- presets: hoje, ontem, últimos 7 dias, últimos 30 dias, mês atual, mês anterior;
- período personalizado;
- comparação com período anterior ou período personalizado;
- múltiplas pastas;
- múltiplos SDRs;
- múltiplos números;
- origem: automática, manual ou todas;
- resultado comercial;
- etapa do funil;
- status técnico;
- opção de incluir ou excluir chamadas ativas;
- resetar filtros;
- salvar filtros como visualização;
- exibir quantidade de filtros ativos.

### 6.2 Cards de KPI

Cards obrigatórios:

- chamadas realizadas;
- leads únicos trabalhados;
- chamadas atendidas;
- taxa de atendimento;
- tempo conectado;
- duração média;
- resultados positivos;
- taxa de pós-atendimento;
- SDRs ativos;
- leads na fila.

Cada card deve exibir valor atual, variação, tendência, período, fórmula e ação de drilldown.

### 6.3 Gráficos

#### Evolução da atividade

Gráfico de linha ou área com granularidade automática:

- hora para períodos de até 48 horas;
- dia para períodos de até 120 dias;
- semana para períodos maiores.

Séries alternáveis: chamadas, atendidas, taxa de atendimento, leads únicos, resultados positivos e tempo conectado.

#### Funil

Etapas sugeridas:

1. leads disponíveis;
2. leads trabalhados;
3. leads atendidos;
4. leads com pós-atendimento;
5. leads com resultado positivo;
6. leads avançados;
7. conversões.

O funil deve informar a regra de contagem e permitir abrir os registros de cada etapa.

#### Resultados e etapas

- barra horizontal para resultados;
- barra horizontal ou empilhada para etapas;
- porcentagem e quantidade absoluta;
- filtros cruzados ao clicar em uma categoria.

#### Heatmap de horário

- eixo horizontal: hora;
- eixo vertical: dia da semana;
- métrica alternável: volume, atendimento, resultado positivo ou falha;
- tooltip com chamadas, atendidas e percentual.

### 6.4 Tabelas gerenciais

#### SDRs

Colunas:

- SDR;
- chamadas;
- leads únicos;
- atendidas;
- taxa de atendimento;
- duração média;
- tempo conectado;
- resultados positivos;
- avanço de etapa;
- pós-atendimentos concluídos;
- taxa de registro;
- meta;
- atingimento;
- status atual.

Recursos: ordenação, busca, paginação, colunas configuráveis, exportação e abertura do detalhe do SDR.

#### Pastas

Colunas:

- pasta;
- leads totais;
- leads trabalhados;
- fila atual;
- chamadas;
- atendimento;
- resultado positivo;
- avanço de etapa;
- conversão;
- melhor horário;
- meta;
- atingimento.

#### Números

Colunas:

- número;
- status;
- chamadas;
- atendimento;
- falhas;
- chamadas simultâneas;
- limite;
- utilização;
- cooldown;
- quarentena;
- última atividade.

### 6.5 Drilldown

Ao clicar em um card, gráfico ou linha:

- abrir drawer lateral sem perder o contexto dos filtros;
- mostrar quais registros formam o indicador;
- permitir navegar para o lead, chamada, SDR, pasta ou número;
- permitir aplicar o item clicado como filtro;
- permitir exportar somente o conjunto filtrado.

O detalhe de uma chamada deve conter lead, pasta, SDR, número, timestamps, tentativa, status, resultado, etapa, duração, falha, nota e histórico de tentativas.

### 6.6 Alertas e insights

Alertas padrão:

- queda de taxa de atendimento acima do limite configurado;
- aumento de falhas técnicas;
- número em quarentena;
- fila sem progresso;
- ausência de SDR disponível com leads prontos;
- pasta ativa sem leads elegíveis;
- pós-atendimentos pendentes;
- volume abaixo da meta;
- concentração de falhas em um número;
- diferença anormal entre chamadas e leads únicos.

Cada alerta deve mostrar severidade, período, evidência, causa provável e ação recomendada. Alertas não devem afirmar causalidade quando os dados apenas indicam correlação.

### 6.7 Metas

Permitir configurar:

- meta de chamadas;
- meta de leads trabalhados;
- meta de atendimento;
- meta de resultados positivos;
- meta de avanço de etapa;
- meta de conversão;
- meta de tempo conectado;
- período da meta;
- escopo: organização, SDR ou pasta;
- valor absoluto ou percentual;
- responsável pela alteração.

Exibir progresso, projeção, diferença para a meta e tendência. Metas antigas devem permanecer congeladas para preservar relatórios históricos.

### 6.8 Exportação e relatórios

- CSV de cada tabela;
- CSV do conjunto filtrado;
- relatório resumido em PDF;
- exportação de gráficos como imagem;
- relatório com período e filtros visíveis;
- visualizações salvas;
- relatório semanal e mensal;
- agendamento de envio por e-mail em fase posterior;
- registro de exportações na auditoria.

## 7. Backend e contrato de API

Criar um módulo próprio:

```text
apps/api/src/modules/metrics/
├── metrics.module.ts
├── metrics.controller.ts
├── metrics.service.ts
├── metrics.repository.ts
├── metrics.definitions.ts
├── metrics.types.ts
├── metrics.export.service.ts
└── dto/
    ├── metrics-query.dto.ts
    ├── create-goal.dto.ts
    ├── update-goal.dto.ts
    └── saved-view.dto.ts
```

### 7.1 Endpoint principal

```http
GET /api/metrics/summary
```

Query parameters:

```text
from=YYYY-MM-DD
to=YYYY-MM-DD
compareFrom=YYYY-MM-DD
compareTo=YYYY-MM-DD
folderIds[]=...
sdrIds[]=...
numberIds[]=...
source=automatico|manual|all
callResults[]=...
pipelineStages[]=...
statuses[]=...
timezone=America/Sao_Paulo
```

Resposta esperada:

```ts
{
  period: { from, to, timezone },
  comparison: { from, to, available: boolean },
  freshness: { generatedAt, dataThrough, delayed: boolean },
  filters: { folders, sdrs, numbers, sources, results, stages },
  kpis: { ... },
  trends: [ ... ],
  funnel: [ ... ],
  outcomes: [ ... ],
  pipeline: [ ... ],
  alerts: [ ... ],
  realtime: { ... }
}
```

### 7.2 Endpoints complementares

```http
GET    /api/metrics/trends
GET    /api/metrics/funnel
GET    /api/metrics/outcomes
GET    /api/metrics/heatmap
GET    /api/metrics/sdrs
GET    /api/metrics/folders
GET    /api/metrics/numbers
GET    /api/metrics/calls
GET    /api/metrics/leads
GET    /api/metrics/alerts
GET    /api/metrics/export.csv
GET    /api/metrics/export.pdf
GET    /api/metrics/goals
POST   /api/metrics/goals
PATCH  /api/metrics/goals/:id
DELETE /api/metrics/goals/:id
GET    /api/metrics/views
POST   /api/metrics/views
PATCH  /api/metrics/views/:id
DELETE /api/metrics/views/:id
```

### 7.3 Regras do backend

- validar todos os filtros com DTOs;
- limitar período máximo por consulta síncrona;
- usar paginação no drilldown;
- impedir acesso cruzado entre tenants;
- aplicar `CurrentTenant` em todas as consultas;
- não permitir que filtros vindos do cliente alterem SQL diretamente;
- retornar metadados de fonte, timezone e frescor;
- padronizar arredondamento de percentuais;
- garantir que denominador zero resulte em percentual zero;
- registrar exportações e alterações de metas na auditoria;
- limitar frequência de consultas pesadas por usuário/tenant;
- garantir que resultados sem dados retornem estrutura completa.

## 8. Evolução do modelo de dados

### 8.1 O que já existe

O modelo atual já possui base para:

- chamadas e timestamps;
- conexão e duração;
- status e motivos de falha;
- origem automática/manual;
- resultado comercial;
- etapa do funil;
- notas e conclusão do pós-atendimento;
- leads e pastas;
- disponibilidade e pausas de SDR;
- status, cooldown e quarentena de números;
- auditoria de importações.

### 8.2 Migrações necessárias

Criar migrações versionadas para:

1. catálogo de resultados comerciais;
2. catálogo de etapas do funil;
3. classificação de resultado: positivo, neutro, negativo, conversão;
4. histórico de alteração de etapa do lead;
5. histórico de disponibilidade do SDR;
6. histórico de status do número;
7. tabela de metas;
8. tabela de visualizações salvas;
9. configurações de alertas;
10. regras de timezone por tenant;
11. campos separados para duração de toque e duração conectada;
12. eventos de métricas, caso a agregação incremental seja adotada;
13. índices para consultas por tenant, data, pasta, SDR, número, status e origem.

### 8.3 Histórico de funil

O campo atual de etapa no lead representa o estado presente. Para analisar avanço histórico, criar uma tabela semelhante a:

```sql
lead_stage_history (
  id,
  tenant_id,
  lead_id,
  from_stage,
  to_stage,
  source,
  call_id,
  changed_by,
  created_at
)
```

Toda mudança de etapa no pós-atendimento deve registrar uma linha. A primeira etapa deve ser registrada na criação do lead.

### 8.4 Agregações

Estratégia recomendada:

- consultas diretas para períodos pequenos;
- tabelas agregadas por hora para períodos maiores;
- rollup diário para relatórios históricos;
- invalidação ou atualização incremental após encerramento de chamada;
- reprocessamento idempotente para corrigir dados;
- retenção definida por tenant e plano.

O frontend não deve executar várias consultas pesadas individualmente para montar a tela principal.

## 9. Frontend e estado

### 9.1 Estado da página

Centralizar em um hook ou store específico:

```ts
useMetrics({
  dateRange,
  comparison,
  filters,
  refreshMode,
})
```

O estado deve controlar:

- filtros;
- período comparativo;
- loading inicial;
- atualização em segundo plano;
- erro parcial por bloco;
- último payload válido;
- exportação em andamento;
- drawer de detalhe;
- visualização salva;
- meta selecionada.

### 9.2 Estados obrigatórios da interface

- carregamento inicial com skeleton;
- atualização em segundo plano sem piscar a tela;
- erro completo;
- erro isolado por widget;
- ausência de dados;
- filtro sem resultado;
- dados atrasados;
- período inválido;
- permissão insuficiente;
- exportação em andamento;
- consulta excedendo limite.

### 9.3 Responsividade

- desktop: dashboard analítico em múltiplas colunas;
- tablet: duas colunas e tabelas com rolagem horizontal;
- mobile: cards empilhados, gráficos simplificados e tabelas em modo de lista;
- filtros em drawer ou bottom sheet;
- drilldown ocupando a tela inteira em telas pequenas.

### 9.4 Acessibilidade

- navegação por teclado;
- foco visível;
- rótulos acessíveis nos gráficos;
- tabela alternativa para cada gráfico;
- cores não podem ser o único indicador;
- contraste compatível;
- suporte a leitores de tela;
- mensagens de atualização anunciadas sem interromper o usuário.

## 10. Performance e escalabilidade

- endpoint agregado único para o carregamento inicial;
- consultas com índices compostos por `tenant_id` e período;
- paginação server-side;
- cache curto para filtros idênticos;
- debounce em filtros de busca;
- lazy loading de abas secundárias;
- exportações grandes em processo assíncrono;
- limite de período para consulta síncrona;
- métricas de duração das queries;
- alertas para regressão de performance;
- testes com volume realista de chamadas e leads.

Critérios iniciais de performance:

- primeira resposta da página em até 2 segundos em volume normal;
- atualização de filtros em até 3 segundos;
- atualização em tempo real sem bloquear interação;
- exportação grande sem travar a API principal;
- consultas paginadas sem retornar milhares de registros de uma vez.

## 11. Segurança e governança

- escopo obrigatório por `tenant_id`;
- métricas organizacionais apenas para líderes e super admins;
- SDR, se receber visão individual no futuro, não pode acessar dados de outros SDRs;
- exportações devem respeitar os mesmos filtros e permissões;
- mascarar telefone em relatórios compartilháveis, se necessário;
- auditar criação, edição e exclusão de metas;
- auditar visualizações compartilhadas;
- auditar exportações que contenham dados pessoais;
- limitar retenção de notas e dados sensíveis;
- respeitar LGPD e finalidade de uso dos contatos.

## 12. Alertas e observabilidade

### 12.1 Logs técnicos

Registrar:

- duração de cada consulta;
- filtros utilizados sem expor dados desnecessários;
- tenant e usuário;
- endpoint de exportação;
- falha de agregação;
- atraso do pipeline de métricas;
- erro na atualização em tempo real.

### 12.2 Indicadores da própria funcionalidade

- tempo p95 do resumo;
- taxa de erro por endpoint;
- tempo p95 de exportação;
- volume de consultas por tenant;
- quantidade de respostas servidas do cache;
- atraso entre evento e métrica disponível;
- quantidade de alertas gerados;
- quantidade de exportações concluídas e falhas.

## 13. Estratégia de implementação por fases

As fases abaixo descrevem a entrega completa. O objetivo não é parar no primeiro conjunto de cards; cada fase depende da anterior e conduz ao produto analítico completo.

### Fase 1 — Contrato de métricas e fundação

- validar as definições com produto e operação;
- definir catálogo de resultados e etapas;
- definir timezone por tenant;
- mapear eventos existentes;
- documentar fórmulas;
- criar tipos compartilhados;
- criar módulo backend de métricas;
- criar DTOs e autorização;
- definir resposta do endpoint principal;
- criar testes das fórmulas.

**Saída:** contrato de dados estável e regras de cálculo aprovadas.

### Fase 2 — Modelo histórico e qualidade dos dados

- criar histórico de etapas;
- registrar histórico de disponibilidade dos SDRs;
- registrar histórico de status dos números;
- separar duração de toque e conexão;
- padronizar resultados comerciais;
- preencher dados retroativos quando possível;
- criar rotina de validação de consistência;
- adicionar índices e constraints.

**Saída:** dados capazes de sustentar análise histórica confiável.

### Fase 3 — Agregação e API analítica

- implementar resumo agregado;
- implementar tendências;
- implementar funil;
- implementar resultados e etapas;
- implementar heatmap;
- implementar rankings;
- implementar drilldowns paginados;
- implementar freshness e data-through;
- adicionar cache e limites;
- validar performance com carga.

**Saída:** API completa para alimentar a experiência sem consultas fragmentadas.

### Fase 4 — Página principal de métricas

- adicionar navegação;
- criar layout da página;
- criar filtros globais;
- criar cards;
- criar gráficos;
- criar tabelas de SDRs, pastas e números;
- criar estados de loading, erro e vazio;
- criar comparação de períodos;
- criar atualização em segundo plano;
- adequar responsividade e acessibilidade.

**Saída:** área analítica utilizável para acompanhamento diário.

### Fase 5 — Exploração, alertas e contexto

- implementar drilldown;
- implementar filtros cruzados;
- implementar alertas;
- implementar insights baseados em regras;
- implementar histórico de chamadas relacionado ao indicador;
- adicionar explicação das métricas;
- adicionar visualização de causa provável;
- adicionar ações recomendadas.

**Saída:** a página passa de relatório para ferramenta de diagnóstico.

### Fase 6 — Metas e gestão de performance

- criar tabelas e endpoints de metas;
- criar configuração por organização, SDR e pasta;
- criar progresso e projeção;
- criar ranking contra meta;
- congelar metas históricas;
- auditar alterações;
- adicionar permissões de gestão;
- criar alertas relacionados a metas.

**Saída:** a liderança consegue acompanhar execução contra objetivos definidos.

### Fase 7 — Exportação, relatórios e visualizações salvas

- exportar tabelas filtradas;
- exportar relatório completo;
- gerar PDF;
- salvar visualizações;
- compartilhar visualização com permissões;
- implementar relatórios semanais e mensais;
- criar processamento assíncrono para arquivos grandes;
- registrar exportações na auditoria.

**Saída:** métricas utilizáveis em reuniões, prestação de contas e planejamento.

### Fase 8 — Escala e otimização

- introduzir agregações horárias e diárias;
- criar reprocessamento idempotente;
- adicionar cache distribuído se necessário;
- criar retenção por plano;
- monitorar p95 e custo das consultas;
- testar tenants com alto volume;
- criar fallback quando agregações estiverem atrasadas;
- revisar índices após dados reais.

**Saída:** funcionalidade preparada para crescimento sem degradar a operação.

## 14. Estratégia de testes

### 14.1 Backend

- testes unitários das fórmulas;
- testes de timezone;
- testes de período inclusivo e exclusivo;
- testes com denominador zero;
- testes de filtros combinados;
- testes de isolamento multi-tenant;
- testes de permissões;
- testes de paginação;
- testes de exportação;
- testes de consistência entre resumo e drilldown;
- testes de reprocessamento idempotente.

### 14.2 Frontend

- renderização com dados completos;
- estados vazios;
- erro parcial;
- filtros e comparação;
- abertura de drawer;
- exportação;
- responsividade;
- teclado e acessibilidade;
- atualização automática sem perda de filtros;
- visualização salva.

### 14.3 Integração

- chamada encerrada atualiza agregação;
- resultado de pós-atendimento aparece no funil;
- mudança de etapa gera histórico;
- chamada manual respeita filtro de origem;
- número em quarentena aparece no alerta;
- alteração de meta aparece no progresso;
- tenant A nunca visualiza dados do tenant B.

### 14.4 Performance

- carga com milhares de leads;
- carga com centenas de milhares de chamadas;
- várias consultas simultâneas;
- exportação grande;
- período longo;
- consulta sem cache;
- consulta com filtros máximos.

## 15. Critérios de aceite

### Dados

- [ ] Todas as métricas possuem fórmula documentada.
- [ ] O resumo e o drilldown fecham matematicamente.
- [ ] O período respeita o timezone da organização.
- [ ] Comparações usam períodos equivalentes.
- [ ] Chamadas manuais e automáticas podem ser separadas.
- [ ] Conversão não é inferida de status técnico.
- [ ] Histórico de etapas está disponível para análise temporal.

### Interface

- [ ] Todos os widgets respeitam os filtros globais.
- [ ] Cada percentual mostra seu denominador.
- [ ] Cards possuem comparação e drilldown.
- [ ] Gráficos possuem alternativa tabular.
- [ ] A tela informa frescor dos dados.
- [ ] Existe tratamento para erro, vazio e atraso.
- [ ] A página funciona em desktop, tablet e mobile.
- [ ] Usuários não autorizados não acessam a área.

### Operação

- [ ] Exportações respeitam tenant, filtros e permissões.
- [ ] Metas possuem histórico de alterações.
- [ ] Alertas possuem evidência e ação recomendada.
- [ ] Consultas pesadas possuem limite ou processamento assíncrono.
- [ ] Logs e métricas técnicas estão disponíveis.
- [ ] A implantação não altera o funcionamento do discador.

## 16. Arquivos que provavelmente serão alterados

### Frontend

- `apps/web/src/app/App.tsx`
- `apps/web/src/types/index.ts`
- `apps/web/src/features/metrics/*`
- `apps/web/src/components/*` para componentes de gráfico, drawer e filtros
- `apps/web/src/services/api.ts` se houver camada específica de métricas
- `apps/web/src/styles/global.css`

### Backend

- `apps/api/src/modules/metrics/*`
- `apps/api/src/database/migrations/*`
- `apps/api/src/modules/dialer/dialer.service.ts` para eventos e durações
- `apps/api/src/modules/leads/*` para histórico de etapa
- `apps/api/src/modules/sdrs/*` para histórico de disponibilidade
- `apps/api/src/modules/numbers/*` para histórico de saúde
- `apps/api/src/modules/audit/*` para exportações e metas
- `apps/api/src/app.module.ts`

## 17. Dependências e decisões a fechar antes do código

1. Quais resultados são positivos, neutros, negativos e conversão?
2. Quais etapas oficiais existem no funil?
3. Conversão representa venda, reunião agendada, oportunidade ou outro evento?
4. Qual timezone padrão de cada organização?
5. Por quanto tempo os dados históricos serão mantidos?
6. Quais usuários podem criar metas?
7. Relatórios serão apenas exportados ou também enviados automaticamente?
8. Qual limite de volume exige agregação assíncrona?
9. Quais dados pessoais devem ser mascarados em exportações?
10. Quais alertas são apenas informativos e quais gerarão notificação?

## 18. Ordem recomendada de execução

1. Aprovar definições e catálogo comercial.
2. Criar migrações históricas e validar dados.
3. Implementar contratos e testes do módulo de métricas.
4. Implementar agregações e drilldowns.
5. Implementar página principal e filtros.
6. Adicionar alertas e explicações.
7. Adicionar metas.
8. Adicionar exportações e relatórios.
9. Adicionar agregações de escala.
10. Rodar validação com dados reais e liberar progressivamente por tenant.

## 19. Resultado esperado

Ao final, o ZapLiga terá uma central de métricas organizacionais capaz de conectar atividade operacional a resultado comercial, preservar histórico, orientar decisões e sustentar crescimento. A implementação deve ser considerada concluída somente quando houver dados confiáveis, drilldown, metas, alertas, exportação, segurança multi-tenant, testes e observabilidade — não apenas uma tela com gráficos.
