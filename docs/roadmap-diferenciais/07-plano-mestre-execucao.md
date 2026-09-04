# Plano mestre de execução — vantagens defensáveis

## Finalidade

Este é o roteiro operacional que o agente deve seguir para implementar os Planos
01 a 06 do roadmap. Ele define ordem, dependências, lotes, validações e condições de
parada. Os planos individuais continuam sendo a fonte de verdade funcional; este
documento decide como transformá-los em entregas seguras e incrementais.

## Objetivo verificável

Concluir a implementação quando uma empresa puder:

1. criar e publicar uma campanha versionada;
2. receber leads vinculados à campanha;
3. operar com uma fila priorizada e explicável;
4. receber recomendações acionáveis e auditadas;
5. acompanhar a saúde da operação e das linhas;
6. usar sinais históricos confiáveis em decisões e experimentos;
7. visualizar benchmarks somente quando privacidade e amostra permitirem;
8. conhecer e demonstrar essa proposta de forma consistente na aplicação e landing.

A conclusão exige backend, frontend, migrations, testes, observabilidade,
documentação e E2E. Código presente, porém inacessível, não testado ou sempre oculto
por feature flag não conta como implementação concluída.

## Fontes de verdade

Executar sempre com estes documentos abertos:

- [Roadmap e dependências](README.md);
- [Plano 01 — campanhas](01-campanhas-playbooks-integracoes.md);
- [Plano 02 — decisão](02-motor-decisao-fila-inteligente.md);
- [Plano 03 — recomendações](03-central-comando-recomendacoes.md);
- [Plano 04 — saúde](04-saude-operacao-confianca.md);
- [Plano 05 — dados](05-dados-aprendizado-benchmarks.md);
- [Plano 06 — posicionamento](06-posicionamento-marca-prova.md);
- [Runbook obrigatório de deploy](../deploy-runbook.md).

Se código e plano divergirem, primeiro registrar a decisão em ADR ou atualizar o
plano com justificativa. Não adaptar silenciosamente o escopo.

## Premissas atuais

- A implementação começa após a migration `041_dialer_pacing_limits.sql`.
- Os números `042` a `046` dos planos são reservas conceituais. Antes de criar cada
  migration, consultar a pasta atual e usar o próximo número livre; migration já
  aplicada nunca deve ser renomeada ou editada retroativamente.
- `ZapLiga` permanece como nome provisório até decisão explícita de identidade.
- Regras determinísticas vêm antes de modelos estatísticos ou IA.
- Feature flags novas iniciam desligadas.
- Benchmarks compartilhados exigem opt-in e validação jurídica antes de exposição.
- Nenhum push, deploy, restart ou alteração em produção está autorizado por este
  documento. O usuário precisa solicitar isso explicitamente.

## Regras de execução do agente

### Antes de cada lote

1. Ler `AGENTS.md` e o plano individual relacionado.
2. Verificar `git status --short` e preservar alterações do usuário.
3. Confirmar migration mais recente e contratos atuais do banco/API.
4. Identificar testes existentes que protegem o fluxo alterado.
5. Atualizar a tabela de acompanhamento deste documento para `em andamento`.
6. Se o lote incluir build, deploy, restart ou produção, reler integralmente
   `docs/deploy-runbook.md` antes da ação.

### Durante cada lote

- Implementar uma fatia vertical: banco → backend → frontend → testes → docs.
- Manter compatibilidade com o fluxo legado enquanto a flag estiver desligada.
- Validar `tenant_id` em consultas, índices, FKs compostas e autorização.
- Registrar mutações na auditoria e métricas técnicas na observabilidade.
- Usar funções puras para regras, fórmulas, elegibilidade, score e recomendações.
- Não colocar analytics, benchmark ou geração de insights no caminho síncrono da
  mídia de áudio ou da reserva da chamada.
- Evitar mudanças amplas em `App.tsx`; extrair domínio para hooks, serviços e
  componentes próprios conforme cada feature cresce.

### Para concluir cada lote

1. Executar testes direcionados do domínio alterado.
2. Executar os gates comuns aplicáveis.
3. Verificar o diff e rodar `git diff --check`.
4. Marcar critérios de aceite atendidos no plano individual.
5. Atualizar o acompanhamento com evidências, arquivos e comandos executados.
6. Não avançar se houver regressão conhecida no discador, áudio, isolamento,
   compliance ou recuperação de migration.

## Gates comuns de qualidade

### Gate Q1 — estático

```powershell
npm run check:structure
npm run typecheck
```

### Gate Q2 — testes automatizados

```powershell
npm test
npm run test:web
```

Além da suíte completa, executar primeiro os testes direcionados dos arquivos
alterados para acelerar diagnóstico.

### Gate Q3 — build

```powershell
npm run build
```

O build deve ocorrer localmente, no GitHub Actions ou em máquina de build. Nunca
compilar Rust/Waxum na VPS de produção.

### Gate Q4 — banco e multitenant

- Usar banco descartável dedicado; nunca aplicar uma migration em produção para
  descobrir se ela funciona.
- Aplicar migrations em banco vazio.
- Aplicar migrations sobre uma base local na versão anterior.
- Confirmar `db:migrate:status` sem pendências inesperadas.
- Atualizar `scripts/verify-multitenant.mjs` com todas as novas tabelas tenant-scoped.
- Executar `npm run verify:multitenant` com o stack local ativo.
- Testar IDOR e referências cruzadas entre dois tenants.

### Gate Q5 — E2E

No desenvolvimento local, usar um nome de projeto Compose exclusivo para não tocar
nos volumes do ambiente principal:

```powershell
docker compose -p zapliga-roadmap-e2e -f docker-compose.yml -f docker-compose.e2e.yml up -d --build postgres redis nats waxum api-a web
npm run verify:multitenant
npm run test:e2e
docker compose -p zapliga-roadmap-e2e -f docker-compose.yml -f docker-compose.e2e.yml down -v
```

Adicionar jornadas novas ao fake determinístico do Waxum. O E2E deve cobrir tanto a
flag desligada quanto o fluxo novo habilitado. Jornadas de áudio existentes são
guardrails e não podem ser removidas para fazer a suíte passar. O `down -v` acima só
é permitido depois de confirmar que o projeto é exatamente `zapliga-roadmap-e2e`.

### Gate Q6 — operação e observabilidade

- Healthcheck permanece saudável com a feature desligada e ligada.
- Métricas e alertas novos não expõem telefone, notas ou segredos.
- Jobs possuem lock, idempotência, retry limitado e comportamento degradado seguro.
- Consultas do tick, reserva e dashboard são comparadas com a baseline registrada no
  Lote 00; regressão relevante precisa ser corrigida ou explicitamente aceita.

### Gate Q7 — prontidão de rollout

- Feature flag desligada por padrão.
- Backfill é idempotente e observável.
- Existe caminho de desativação sem apagar dados.
- Migrations são compatíveis com versão anterior da aplicação durante rollout.
- Runbook e troubleshooting descrevem sintomas, diagnóstico e recuperação.

## Estratégia de migrations

Toda alteração de banco seguirá expansão e contração:

1. adicionar tabelas/colunas nullable ou com default seguro;
2. publicar código que lê o legado e escreve os dois formatos quando necessário;
3. executar backfill idempotente e mensurável;
4. habilitar leitura nova por feature flag;
5. remover compatibilidade somente em lote posterior, após validação;
6. criar nova migration para qualquer correção após aplicação bem-sucedida.

Índices pesados devem ser avaliados com volume representativo. Migração não pode
depender de serviço externo ou chamada de rede.

## Lotes de implementação

### Lote 00 — baseline, contratos e trilhos

**Planos relacionados:** todos.

Entregas:

- registrar baseline de testes, E2E, consultas críticas e métricas operacionais;
- criar ADR de precedência entre regra global, campanha, segurança e compliance;
- adicionar flags `campaigns`, `decision_engine`, `recommendations`,
  `operation_health`, `analytics_learning`, `experiments` e `benchmarks`;
- definir catálogo compartilhado de estados, reason codes e eventos;
- preparar factories/fixtures com dois tenants, campanhas, linhas, SDRs e leads;
- documentar matriz de compatibilidade com flags desligadas.

Gate de saída:

- baseline reproduzível registrada;
- flags retornam `false` por padrão e são auditadas;
- nenhum comportamento atual muda com todas desligadas;
- Q1, Q2 e Q4 aprovados.

### Lote 01 — domínio de campanhas e leitura

**Fonte:** Plano 01, Fase 1.

Entregas:

- migration de `campaigns`, versões, vínculos com pasta, SDRs e números;
- FKs compostas e índices tenant-scoped;
- backfill de campanha legada sem alterar a fila;
- módulo backend com listagem e detalhe;
- APIs somente leitura e testes de autorização/IDOR;
- suporte administrativo para habilitar a flag em tenant de teste.

Gate de saída:

- uma base antiga migra sem alterar chamadas existentes;
- campanha legada representa a operação atual;
- API antiga responde igual com a flag desligada;
- Q1 a Q4 aprovados.

### Lote 02 — ciclo de vida e versionamento de campanhas

**Fonte:** Plano 01, Fase 2.

Entregas:

- criação, edição, publicação, duplicação, pausa, conclusão e arquivamento;
- validador puro de configuração e resolução de precedência;
- snapshots imutáveis, hash e diff entre versões;
- auditoria completa;
- wizard frontend e detalhe da campanha;
- testes de transição inválida, concorrência e edição durante execução.

Gate de saída:

- líder publica campanha válida pelo painel;
- alteração cria versão nova sem reescrever a anterior;
- campanha inválida não entra em estado `ready` ou `running`;
- Q1, Q2, Q4 e E2E específico aprovados.

### Lote 03 — execução por campanha, integrações e playbooks

**Fonte:** Plano 01, Fases 3 e 4.

Entregas:

- resolução efetiva de agenda, cadência, linhas e SDRs por campanha;
- `campaign_id` e versão efetiva gravados em leads/chamadas aplicáveis;
- fairness básico entre campanhas ativas;
- associação de integração de entrada à campanha;
- duplicação e salvamento como playbook;
- eventos de saída registrados em outbox, ainda sem depender de entrega externa;
- E2E completo: ingestão → campanha → chamada → resultado.

Gate de saída:

- chamadas reservadas mantêm versão original após edição da campanha;
- limites de campanha nunca ultrapassam teto global;
- falha na resolução retorna ao comportamento seguro;
- Q1 a Q6 aprovados.

### Lote 04 — elegibilidade unificada

**Fonte:** Plano 02, Fase 1.

Entregas:

- extrair regras duras do `DialerService` para contrato único e testável;
- usar a mesma elegibilidade na fila automática, manual, preview e simulação;
- retornar reason codes estruturados para permitido/bloqueado;
- manter revalidação transacional na reserva;
- testes de paridade com todos os cenários atuais.

Gate de saída:

- suite demonstra paridade entre implementação antiga e nova;
- supressão, agenda, callback, limite e saúde continuam invioláveis;
- nenhuma regra existe somente no frontend;
- Q1 a Q6 aprovados.

### Lote 05 — score determinístico e simulação

**Fonte:** Plano 02, Fases 2 e 3.

Entregas:

- migration de políticas e decisões;
- fórmula determinística versionada;
- API de simulação e contrato de explicação;
- modo sombra sem mudança de ordem;
- comparação FIFO/prioridade atual versus score;
- interface “Por que este lead?” e monitor de distribuição/fairness.

Gate de saída:

- mesma entrada e versão produzem mesmo resultado;
- snapshot não contém PII desnecessária;
- shadow mode não altera estado, ordem ou quantidade de chamadas;
- fallback funciona quando avaliação falha;
- Q1 a Q6 aprovados.

### Lote 06 — ativação da fila inteligente

**Fonte:** Plano 02, Fases 4 e 5, sem sinais históricos ainda.

Entregas:

- modo ativo por campanha;
- ordenação por score com desempate determinístico;
- fairness e proteção contra starvation;
- kill switch para estratégia anterior;
- métricas de decisão, fallback e latência;
- rollout local e staging: desligado → sombra → ativo em campanha controlada.

Gate de saída:

- rollback por flag não requer migration reversa;
- reserva concorrente continua atômica;
- nenhuma campanha elegível fica indefinidamente sem capacidade;
- Q1 a Q7 aprovados.

### Lote 07 — catálogo e central de recomendações

**Fonte:** Plano 03, Fases 1 e 2.

Entregas:

- migration de recomendações e eventos de interação;
- catálogo único substituindo gradualmente `metrics-alerts.ts`;
- deduplicação, prioridade, expiração e invalidação;
- API e consumo em `OrganizerOverview`;
- no máximo três prioridades principais;
- eventos de impressão, abertura, adiamento e dispensa.

Gate de saída:

- alertas atuais mantêm equivalência funcional;
- evidência e atualização estão visíveis;
- condição resolvida remove recomendação obsoleta;
- Q1, Q2, Q4, Q5 e Q6 aprovados.

### Lote 08 — ações recomendadas seguras

**Fonte:** Plano 03, Fases 3 e 4.

Entregas:

- catálogo fechado de ações permitidas;
- revalidação de estado e autorização no momento da aplicação;
- idempotência e confirmação proporcional ao impacto;
- histórico antes/depois e resultado da ação;
- oportunidades baseadas em campanha e score, rotuladas como hipótese quando cabível.

Gate de saída:

- executar duas vezes não duplica efeito;
- payload arbitrário não pode invocar ação;
- recomendação nunca remove proteção de compliance ou saúde;
- Q1 a Q7 aprovados.

### Lote 09 — telemetria e score de saúde

**Fonte:** Plano 04, Fases 1 e 2.

Entregas:

- completar reason codes e eventos de linha ausentes;
- migration de snapshots e eventos de saúde;
- fórmula pura e versionada de estado/score;
- estado `dados insuficientes`;
- API geral e por número;
- adaptador que cria recomendações de risco.

Gate de saída:

- mesma entrada produz mesmo score na mesma versão;
- bloqueio de compliance não é compensável;
- restart preserva evidência necessária;
- Q1 a Q6 aprovados.

### Lote 10 — experiência de saúde e histórico

**Fonte:** Plano 04, Fases 3 e 4.

Entregas:

- card na central, página dedicada e drilldown por linha;
- timeline distinguindo sistema e intervenção humana;
- capacidade atual e próxima liberação estimada;
- snapshots históricos e tendência;
- documentação pública da fórmula como score interno do ZapLiga.

Gate de saída:

- todo estado degradado aponta evidência verificável;
- tela não apresenta limite interno como regra oficial do WhatsApp;
- histórico sobrevive a troca de instância da API;
- Q1, Q2, Q4, Q5 e Q6 aprovados.

### Lote 11 — contrato analítico, outbox e qualidade

**Fonte:** Plano 05, Fase 1, e entrega de webhooks do Plano 01.

Entregas:

- catálogo versionado de eventos analíticos;
- outbox transacional e consumidor idempotente;
- reconciliação de eventos e indicador de confiabilidade;
- entrega de outbound webhooks com assinatura, retry e dead-letter;
- remoção de PII desnecessária do payload analítico;
- métricas de cobertura, atraso e divergência.

Gate de saída:

- evento duplicado não altera agregados nem dispara efeito duplicado;
- indisponibilidade analítica não bloqueia chamada;
- divergência pode ser rastreada até evento e fórmula;
- Q1 a Q7 aprovados.

### Lote 12 — aprendizado por tenant

**Fonte:** Plano 05, Fase 2.

Entregas:

- agregados por horário, origem, campanha, recência e tentativa;
- amostra mínima, suavização e estado `dados insuficientes`;
- melhores horários e insights por campanha;
- consumo desses sinais apenas no modo sombra do motor;
- monitor de estabilidade e viés de seleção.

Gate de saída:

- sinal sem amostra não influencia decisão;
- cada insight mostra período, denominador e confiança;
- ativação não piora saúde ou compliance nos guardrails definidos;
- Q1 a Q7 aprovados.

### Lote 13 — experimentos controlados

**Fonte:** Plano 05, Fase 3.

Entregas:

- migration de experimentos e atribuições;
- hipótese, métrica primária, variantes e guardrails obrigatórios;
- atribuição estável e parada imediata;
- relatório com amostra e incerteza;
- UI inicialmente limitada a cadência e prioridade.

Gate de saída:

- experimento não inicia sem definição completa;
- lead não troca de variante durante a campanha;
- guardrail interrompe experimento inseguro;
- relatório não declara causalidade fora do desenho experimental;
- Q1 a Q7 aprovados.

### Lote 14 — benchmarks privados e produto

**Fonte:** Plano 05, Fases 4 e 5.

Dependências externas obrigatórias:

- texto jurídico e finalidade aprovados;
- opt-in explícito;
- definição formal do mínimo de tenants por coorte;
- volume real suficiente.

Entregas implementáveis antes da liberação:

- consentimento versionado e revogação;
- agregação sem PII e supressão de extremos;
- ferramenta interna de inspeção de coortes;
- bloqueio automático de coorte insuficiente;
- UI de percentis e metodologia atrás da flag `benchmarks`.

Gate de saída:

- nenhum tenant individual pode ser inferido;
- opt-out impede novos processamentos compartilhados;
- sem aprovação/volume, a infraestrutura pode ficar pronta, mas benchmark visível
  permanece bloqueado e o lote não é marcado como totalmente concluído;
- Q1 a Q7 e revisão jurídica aprovados.

### Lote 15 — identidade, linguagem e onboarding

**Fonte:** Plano 06, Fases 1 e 2.

Dependência externa obrigatória: decisão do usuário entre `ZapLiga`, `ZapCall` ou
outro nome oficial.

Entregas:

- ADR de identidade, categoria, promessa e nomenclatura;
- inventário e correção de termos divergentes;
- navegação consistente para campanhas, decisões, recomendações e saúde;
- onboarding até primeira campanha, primeiro lead e primeira conversa;
- eventos de abandono e primeira evidência de valor.

Gate de saída:

- aplicação, landing e documentação usam a identidade decidida;
- troca de marca não altera chaves técnicas ou integrações sem plano de migração;
- onboarding possui E2E e analytics sem PII;
- Q1, Q2, Q3 e Q5 aprovados.

### Lote 16 — demo pública, metodologia e prova

**Fonte:** Plano 06, Fases 3 e 4.

Entregas:

- demo isolada com fixtures sintéticas e ciclo completo;
- rótulo inequívoco de simulação;
- páginas de metodologia e confiança;
- resumo executivo exportável sem PII;
- acessibilidade, responsividade e `prefers-reduced-motion`;
- estrutura para estudos de caso reais autorizados.

Dependência externa: alegações quantitativas e estudos de caso só entram após dados,
autorização e metodologia verificável.

Gate de saída:

- demo não acessa API, sessão, QR, segredo ou telefone de produção;
- narrativa descreve somente capacidades disponíveis conforme flags públicas;
- toda alegação numérica publicada tem fonte;
- Q1, Q2, Q3 e testes de acessibilidade/responsividade aprovados.

### Lote 17 — hardening e aceite integrado

**Planos relacionados:** todos.

Entregas:

- executar os 48 critérios de aceite dos seis planos e registrar evidência;
- testes de carga do tick, score, recomendações, health e jobs;
- teste de falha de Redis, NATS, banco, Waxum e consumidor analítico;
- revisão de segurança, LGPD, retenção, logs e exportações;
- E2E integrado da primeira campanha ao resultado e insight;
- atualizar arquitetura, troubleshooting, eventos de auditoria e runbooks;
- remover somente compatibilidade legada comprovadamente sem uso.

Gate de saída:

- Q1 a Q7 aprovados;
- nenhuma pendência crítica ou alta conhecida;
- todas as flags possuem dono, estado esperado e procedimento de rollback;
- critérios bloqueados por dependência externa aparecem explicitamente, não como
  conclusão falsa.

### Lote 18 — rollout controlado

Este lote só começa após autorização explícita do usuário e nova leitura integral
do runbook.

Ordem:

1. ambiente local completo;
2. CI com fake Waxum;
3. staging com dados sintéticos;
4. staging com linha autorizada e smoke real;
5. tenant piloto com flags individuais;
6. expansão gradual por feature;
7. ativação ampla somente após métricas e janela de observação definidas.

Cada feature avança separadamente. Falha em decisão inteligente, analytics ou
benchmark deve permitir desligar essa camada mantendo campanhas e discador básico.

## Matriz mínima de testes novos

| Domínio | Unitário | Integração/API | E2E | Segurança/operacional |
| --- | --- | --- | --- | --- |
| campanhas | regras e transições | CRUD, versões e IDOR | publicar/iniciar/pausar | concorrência e teto global |
| decisão | elegibilidade e score | simulação e histórico | sombra/ativo/fallback | starvation e reserva atômica |
| recomendações | regras e ranking | ações e idempotência | detectar/aplicar/resolver | estado obsoleto e permissão |
| saúde | fórmula e reason codes | snapshots e timeline | degradar/recuperar | restart, 429 e quarentena |
| analytics | agregação e qualidade | outbox, retry e consentimento | insight/experimento | PII, duplicidade e indisponibilidade |
| benchmark | coorte e supressão | opt-in/opt-out | visível/bloqueado | inferência e baixa amostra |
| marca/demo | componentes e fixtures | analytics público | jornada da demo | isolamento de produção |

## Condições que exigem pausa e decisão do usuário

O agente deve continuar autonomamente até encontrar uma destas condições:

- escolha do nome oficial e domínio público;
- contratação, credenciais ou escrita em serviço externo;
- definição jurídica para benchmark, gravação, transcrição ou novo uso de dados;
- necessidade de publicar alegação quantitativa real;
- push em `main`, deploy, restart ou alteração em produção;
- migration incompatível que exija downtime ou restauração planejada;
- conflito com alteração do usuário no mesmo trecho que não possa ser preservada;
- mudança de escopo para CRM, mensagens automáticas ou IA autônoma.

Uma pausa deve informar lote, evidência já concluída, decisão necessária e impacto
das alternativas. Falta de tempo ou tamanho do trabalho não é motivo para marcar o
plano como bloqueado.

## Acompanhamento persistente

Atualizar esta tabela ao final de cada lote. Estados válidos: `pendente`,
`em andamento`, `concluído`, `bloqueado externamente`.

| Lote | Estado | Evidência |
| ---: | --- | --- |
| 00 | concluído | Baseline, flags, contratos, fixtures, compatibilidade e gates Q1/Q2/Q4 aprovados em `evidencias/lote-00-baseline.md`. |
| 01 | concluído | Domínio/read model, backfill legado, APIs tenant-scoped e gates Q1–Q4 aprovados em `evidencias/lote-01-campanhas-leitura.md`. |
| 02 | pendente | — |
| 03 | pendente | — |
| 04 | pendente | — |
| 05 | pendente | — |
| 06 | pendente | — |
| 07 | pendente | — |
| 08 | pendente | — |
| 09 | pendente | — |
| 10 | pendente | — |
| 11 | pendente | — |
| 12 | pendente | — |
| 13 | pendente | — |
| 14 | pendente | — |
| 15 | pendente | — |
| 16 | pendente | — |
| 17 | pendente | — |
| 18 | pendente | — |

## Definição final de pronto

O conjunto está pronto somente quando:

- todos os lotes implementáveis estão concluídos com evidência;
- os critérios dos seis planos foram verificados;
- a jornada integrada funciona com flags ligadas e o legado funciona com flags
  desligadas;
- decisões são explicáveis e ações auditáveis;
- falhas de camadas novas degradam para operação segura;
- nenhum dado entre tenants vaza por API, evento, cache, log ou benchmark;
- documentação operacional corresponde ao código entregue;
- dependências externas restantes estão explicitamente aprovadas ou marcadas como
  bloqueadas, sem serem apresentadas como concluídas.

## Próxima ação de execução

Quando o usuário autorizar o início da implementação, começar pelo Lote 00. Não
iniciar diretamente pela UI de campanhas nem pelo score: baseline, flags, contratos
e matriz de compatibilidade são os guardrails para todo o restante.
