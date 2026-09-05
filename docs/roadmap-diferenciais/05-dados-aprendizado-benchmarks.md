# Plano 05 — Dados, aprendizado e benchmarks

## Resultado desejado

Fazer o desempenho acumulado melhorar as próximas decisões do ZapLiga e criar uma
vantagem de dados que não dependa de expor informações de clientes ou leads.

## Estratégia

Evoluir em três níveis:

1. analytics confiável por tenant;
2. recomendações personalizadas com experimentação;
3. benchmarks agregados entre operações comparáveis.

O nível seguinte só começa quando o anterior possui qualidade, volume e governança
suficientes.

## Base existente

Chamadas já preservam origem, pasta, número, SDR, resultado, etapa, duração e estado.
Há históricos de etapa, disponibilidade e número, rollups diários, métricas e metas.
Campanhas e decisões versionadas completarão o contexto que ainda falta.

## Contrato de eventos analíticos

Criar um catálogo versionado para:

```text
lead.received
lead.eligible
lead.suppressed
decision.scored
decision.selected
call.reserved
call.connected
call.ended
wrap_up.completed
callback.created
callback.completed
stage.changed
campaign.started
campaign.completed
health.changed
recommendation.applied
```

Cada evento inclui `tenant_id`, timestamp, versão do schema, IDs de correlação e
atributos mínimos. Nome, telefone, notas e conteúdo livre não entram no dataset
analítico padrão.

## Qualidade de dados

Implementar verificações para:

- eventos duplicados ou fora de ordem;
- chamada sem campanha/versão após adoção do novo domínio;
- resultado incompatível com catálogo;
- duração negativa ou transição impossível;
- timestamps futuros;
- origem desconhecida;
- divergência entre rollup e fonte transacional.

Expor um indicador de confiabilidade por período. Recomendações históricas devem ser
desativadas quando a confiabilidade estiver abaixo do mínimo definido pelo produto.

## Aprendizado por tenant

Começar com estatística explicável:

- taxa de atendimento por dia e hora;
- resultado positivo por campanha e origem;
- tempo até primeira tentativa;
- tentativas até atendimento;
- desempenho por estágio e recência do lead;
- estabilidade por linha e cadência.

Aplicar suavização e amostra mínima para evitar conclusões sobre poucos eventos. O
produto deve dizer “dados insuficientes” em vez de inventar uma recomendação.

## Experimentos

### Migration proposta: `046_experiments_and_benchmarks.sql`

Criar `experiments`:

- tenant, campanha, hipótese, métrica primária e guardrails;
- variantes, distribuição, início, fim e estado;
- versão da política de decisão.

Criar `experiment_assignments` sem dados pessoais em claro.

Criar `benchmark_consents`:

- opt-in/opt-out por tenant;
- versão dos termos e finalidades permitidas;
- ator e timestamps.

Criar tabelas agregadas de benchmark somente quando o volume justificar; antes
disso, gerar agregados por job com retenção curta e acesso restrito.

## Regras de experimento

- Uma hipótese e uma métrica primária por experimento.
- Guardrails obrigatórios: falhas, opt-out, quedas rápidas e saúde da linha.
- Atribuição estável por lead/campanha para evitar troca de variante.
- Possibilidade de parada imediata.
- Resultado deve mostrar intervalo de confiança e tamanho da amostra.
- Não declarar vencedor antes do critério definido.

## Benchmarks agregados

Comparar somente coortes coerentes, por exemplo:

- segmento declarado;
- porte da equipe;
- faixa de volume;
- tipo de origem;
- período e timezone comparáveis.

Proteções mínimas:

- opt-in explícito;
- nenhuma dimensão com telefone, pessoa ou texto livre;
- coorte com número mínimo de tenants;
- supressão de extremos identificáveis;
- nenhum ranking nominal entre clientes;
- revogação válida para novos processamentos;
- documentação da metodologia.

## Backend e jobs

Criar `apps/api/src/modules/analytics-events/`, `experiments/` e `benchmarks/`.
Eventos operacionais podem ser publicados no NATS JetStream e consumidos de forma
idempotente. O caminho de chamada não deve aguardar processamento analítico.

Jobs principais:

- validação e reconciliação de eventos;
- agregação horária/diária;
- cálculo de sinais por tenant;
- avaliação de experimentos;
- formação de coortes elegíveis;
- expiração e recomputação após mudança de consentimento.

## Frontend

- “Melhores horários” com amostra e metodologia.
- Insights por campanha e origem.
- Criador simples de experimento, inicialmente restrito a cadência e prioridade.
- Tela de resultado sem linguagem causal indevida.
- Benchmark: “operações semelhantes” com faixa percentil e tamanho do coorte.
- Controle de participação e explicação de privacidade.

## Fases

### Fase 1 — contrato e qualidade — concluída no Lote 11

- Catálogo de eventos, idempotência e reconciliação.
- Indicador de confiabilidade.

### Fase 2 — sinais personalizados — concluída no Lote 12

- Agregados por tenant, amostra mínima, suavização, monitor de estabilidade e
  consumo no motor em sombra.

### Fase 3 — experimentação — concluída no Lote 13

- Variantes, guardrails, atribuição estável, integração segura com o discador e
  relatório descritivo com incerteza.

### Fase 4 — benchmark privado — infraestrutura pronta no Lote 14

- Opt-in versionado, revogação, coortes e inspeção interna implementados.
- Validação jurídica, piloto e liberação permanecem externos.

### Fase 5 — benchmark no produto — bloqueada até aprovação e volume

- UI e bloqueios implementados; exibição real depende dos limites aprovados e de
  volume suficiente.

## Critérios de aceite

- [x] Eventos duplicados não alteram agregados.
- [x] É possível rastrear uma métrica até eventos e versão de fórmula.
- [x] Sinais de baixa amostra não influenciam decisões ativas.
- [x] Experimentos possuem hipótese, métrica primária e guardrails antes de iniciar.
- [x] Opt-out impede novos usos nos agregados compartilhados.
- [x] Benchmarks nunca permitem inferir resultado de um tenant específico.
- [x] O caminho do discador funciona mesmo com pipeline analítico indisponível.
- [x] Insights informam amostra, período e grau de confiança.

## Métricas

- cobertura e atraso dos eventos;
- divergência entre rollup e fonte;
- percentual de decisões com sinais históricos válidos;
- uplift observado em experimentos concluídos;
- quantidade de coortes elegíveis;
- participação opt-in;
- consultas bloqueadas por baixa amostra ou privacidade.

## Riscos

- Resultado enviesado por seleção: exigir experimentos quando houver alegação causal.
- Vazamento entre tenants: manter dados brutos separados e compartilhar só agregados.
- Complexidade operacional: começar por regras e estatística, não por infraestrutura
  de machine learning completa.
- Incentivos ruins: incluir saúde, opt-out e falhas como guardrails de otimização.
