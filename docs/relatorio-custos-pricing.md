# Relatório de custos, capacidade e pricing — ZapLiga

**Data-base:** 31/08/2026  
**Escopo:** código e infraestrutura presentes neste workspace, mais os dados de produção registrados no material existente.  
**Regra de leitura:** fatos medidos/confirmados estão marcados como **medido**; números de planejamento estão marcados como **estimado**.

## A. Resumo executivo

O custo direto de adicionar um SDR cadastrado é **R$ 0,00/mês**: não há licença por usuário, API de IA, chip, número ou gravação de áudio cobrados pelo produto. O custo real cresce por quatro vetores:

1. chamadas simultâneas e WebSockets de áudio;
2. sessões/números WhatsApp — fornecidos pelo cliente, mas processados pelo Waxum;
3. crescimento de leads, chamadas, auditoria e índices no PostgreSQL;
4. suporte e onboarding humano.

O host atual tem **4 vCPU, 6 GB RAM e 100 GB** (**medido no material de produção**) e custa **R$ 44,90/mês**. O sistema atual executa PostgreSQL, Redis, NATS, Waxum, duas instâncias de API, web e backup no mesmo host. O código não armazena áudio; ele faz relay binário em WebSocket.

Não há evidência suficiente para afirmar que o host suporta 50 ou 100 organizações com chamadas reais. O material disponível mostra apenas uma sessão Waxum ativa e pico histórico pequeno; os testes sintéticos de WebSocket não exercitam a sinalização completa do WhatsApp. Portanto:

- **limite comercial recomendado antes de teste ponta a ponta:** 20 chamadas simultâneas por host como teto de planejamento conservador, não como benchmark comprovado;
- com o limite padrão de **1 chamada concorrente por organização**, isso equivale a **20 organizações**;
- 20 organizações × 3 SDRs = **60 seats**, porque seat conectado não equivale a chamada ativa;
- se cada organização vender 3 chamadas simultâneas, o mesmo host deve ser planejado para apenas **6 organizações**;
- o primeiro gargalo provável é **Waxum/WhatsApp e o limite operacional por linha**, antes de CPU, RAM ou banco.

## B. O que a aplicação realmente usa

| Componente | Evidência no código | Custo direto atual |
|---|---|---:|
| API | NestJS/Node, duas instâncias no Compose | incluído no VPS |
| Frontend | SPA React/Vite servido por Nginx | incluído no VPS |
| PostgreSQL | PostgreSQL 16, SQL via pg, migrations e índices | OSS; custo é CPU/RAM/disco |
| Redis | locks Lua, cache, rate limit e métricas | OSS; custo é CPU/RAM/disco |
| NATS JetStream | eventos de atendimento do Waxum | OSS; custo é CPU/RAM/disco |
| Waxum | uma imagem fixada, uma sessão por número | sem licença detectada; risco externo |
| Áudio | relay PCM binário, sem transcodificação nem gravação | tráfego e sockets |
| E-mail | Resend para convites, verificação e recuperação | gratuito até o limite; depois pago |
| Observabilidade | Sentry opcional; métricas Prometheus expostas | R$ 0 desligado; pago recomendado |
| Backups | pg_dump diário local, retenção 7 dias/4 semanas/6 meses | incluído no disco, mas não é DR |
| Domínio/SSL | Nginx usa api.zapliga.com; certificado externo ao Compose | domínio separado; SSL pode ser gratuito |
| IA | nenhuma dependência de IA identificada | R$ 0 |
| Mensageria WhatsApp | não há API oficial de mensagens; é voz via Waxum | R$ 0 por mensagem hoje |

### Pontos técnicos que mudam o custo

- Cada tick do discador ocorre a cada 1 segundo e percorre todos os tenants ativos. O custo cresce com organizações ativas, mesmo quando a fila está vazia.
- O dashboard faz polling recorrente; o getStatus tem cache curto, mas endpoints de operação ainda geram tráfego e consultas.
- O relay de áudio já tem descarte por backpressure acima de 256 KB, reduzindo risco de crescimento ilimitado de memória.
- O PostgreSQL tem índices tenant-scoped e a importação CSV foi otimizada em lotes de 500 linhas. Ainda assim, calls, leads, auditoria e históricos não têm retenção operacional completa.
- O código de socket do SDR, chamadas ativas e parte do estado do discador permanece em memória local. As duas APIs do Compose não são um scale-out horizontal seguro sem afinidade consistente e/ou estado distribuído.
- O lock do tick usa uma chave que inclui runtimeInstanceId; por isso api-a e api-b podem executar a varredura do mesmo tenant em paralelo. A reserva em Redis reduz duplicidade de chamadas, mas não elimina trabalho duplicado.

## C. Capacidade do host atual

### C.1 Medido versus estimado

**Medido no material de produção disponível:** 4 vCPU, 6 GB RAM, aproximadamente 100 GB de disco; duas APIs; uma sessão Waxum ativa; uso baixo em repouso; testes sintéticos de WebSocket sem chamada WhatsApp ponta a ponta.

**Não medido:** teto de chamadas reais, taxa de sucesso por linha, consumo do Waxum durante chamadas reais, perda de áudio sob carga externa, limite por conta WhatsApp, tráfego mensal real, tamanho médio efetivo das linhas do banco e disponibilidade de cada número.

### C.2 Teto de planejamento conservador

Para operar com folga, reservei aproximadamente 25% do host para sistema, Docker, picos, backup e recuperação. A capacidade comercial provisória usa **20 chamadas de áudio simultâneas por host**. Essa escolha aplica margem sobre os testes sintéticos e reconhece que o Waxum/WhatsApp não foi saturado no teste.

| Perfil | SDR/org | Leads/org | Chamadas/org/mês | Pico planejado/org | Organizações | SDRs |
|---|---:|---:|---:|---:|---:|---:|
| Pequeno | 1 | 10 mil | 3 mil | 1 | 20 | 20 |
| Inicial | 3 | 30 mil | 9 mil | 1 | 20 | 60 |
| Médio | 5 | 50 mil | 15 mil | 1 | 20 | 100 |
| Grande | 10 | 100 mil | 30 mil | 1 | 20 | 200 |
| Alta concorrência | 20 | 100 mil | 30 mil | 3 | 6 | 120 |

Os números de leads e chamadas são **premissas de planejamento**, não limites do produto. Uma organização com 10 SDRs não consome 10 vezes mais infraestrutura se o plano permitir apenas uma chamada simultânea; consome mais polling, consultas, conexões e suporte. O plano deve limitar explicitamente concorrência e fair use.

### C.3 Números, cooldown e produtividade

O banco cria cada número com max_concurrent_calls = 1 e cooldown padrão de 60 segundos. Na prática, uma organização precisa de ao menos um número saudável para uma chamada simultânea; para mais concorrência, precisa de mais linhas ou de limites explicitamente testados. O código também coloca uma linha em quarentena quando identifica falhas rápidas repetidas.

Como referência operacional, usando 9 horas/dia, 20 dias/mês e 2,5 minutos médios por tentativa, 20 chamadas concorrentes produziriam aproximadamente 2.500–2.600 tentativas/dia a 60% de ocupação. Isso é uma **capacidade matemática de agenda**, não uma promessa de entregabilidade do WhatsApp.

## D. Custos unitários

### D.1 Infraestrutura

O rateio correto é por capacidade vendável, não por seat cadastrado:

    custo médio por organização = custo mensal da plataforma / organizações no estágio
    custo por chamada simultânea = custo mensal da plataforma / chamadas simultâneas vendáveis

No host atual, R$ 44,90 / 20 organizações = **R$ 2,25 por organização/mês** apenas de VPS no estágio cheio. Em 5 organizações, é R$ 8,98. Esse rateio não é o custo total: backup externo, monitoramento, domínio, e-mail, suporte e pagamento ficam fora.

### D.2 SDR adicional

| Item | Custo direto marginal |
|---|---:|
| Cadastro e autenticação | R$ 0,00 |
| Seat conectado, sem chamada | próximo de R$ 0,00 |
| Seat em chamada | custo indireto de concorrência, tráfego, Waxum e suporte |
| Custo alocado de gestão | depende do plano e da concorrência, não de licença |

Recomendação: cobrar por SDR por valor, governança e suporte — não alegar que existe taxa técnica por seat.

### D.3 Onboarding

Usei **R$ 50/hora carregada** como premissa conservadora para operador, incluindo encargos e tempo administrativo. Assim:

- custo mínimo de onboarding: **R$ 50 por organização**;
- com 15 minutos de follow-up e registro: reserve **R$ 62,50**;
- uma pessoa com 160 horas/mês não deve ser vendida como 160 onboardings: planeje **70–80/mês**;
- 40 onboardings/mês consomem aproximadamente R$ 2.000 de custo direto de operador.

**Recomendação comercial:** cobrar **setup de R$ 149** ou isentar apenas em plano anual/pré-pago. Incluir setup gratuitamente em um plano mensal barato destrói margem no primeiro mês, principalmente com CAC alto.

## E. Custos fixos, variáveis e semi-variáveis

### Fixos

- VPS atual: R$ 44,90/mês;
- domínio: usar o custo real de renovação; o material de produção registrou R$ 7,92/mês equivalente;
- monitoramento e alertas;
- administração, suporte e engenharia;
- backup externo — o backup local atual não protege contra perda do host.

### Variáveis

- taxa de pagamento: 6%–8% da receita;
- horas de onboarding;
- suporte por organização;
- crescimento de leads, chamadas, índices, auditoria e histórico;
- e-mails transacionais acima da franquia;
- storage externo e tráfego, se o backup for realmente off-site.

### Semi-variáveis

- upgrade ou multiplicação de VPS quando o host atingir o limite de chamadas;
- separar PostgreSQL/Redis/NATS do app;
- separar Waxum por grupo de sessões;
- observabilidade paga;
- e-mail pago quando o volume ou limite diário gratuito for atingido.

## F. Simulação de infraestrutura por escala

A tabela usa a unidade conservadora de 20 organizações/host, 3 SDRs/org, 1 chamada simultânea/org e orçamento com VPS R$ 44,90; R$ 30 por unidade para backup/storage externo; R$ 10 por unidade para logs/storage; domínio R$ 7,92; Sentry Team a US$ 26/mês; e Resend Pro a US$ 20/mês quando o e-mail pago for necessário. Para conversão, usei R$ 5,19/US$ como premissa; impostos e câmbio podem variar.

| Organizações | SDRs | Chamadas simultâneas | VPS | Arquitetura sugerida | PG | Redis | Waxum | Storage | Infra/mês | Infra/org | Infra/SDR |
|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 10 | 30 | 10 | 1 | all-in-one com folga | 1 | 1 | 1 | 100 GB | R$ 228 | R$ 22,78 | R$ 7,59 |
| 25 | 75 | 25 | 2 | dois nós; dados compartilhados | 1 | 1 | 2 | 200 GB | R$ 305 | R$ 12,18 | R$ 4,06 |
| 50 | 150 | 50 | 3 | app/Waxum separados; PG único | 1 | 1 | 2 | 300 GB | R$ 502 | R$ 10,03 | R$ 3,34 |
| 100 | 300 | 100 | 5 | 2 app + 2 Waxum + dados | 1 | 1 | 2 | 500 GB | R$ 671 | R$ 6,71 | R$ 2,24 |
| 250 | 750 | 250 | 13 | pool de app/Waxum + dados | 2 | 2 | 6 | 1,3 TB | R$ 1.351 | R$ 5,40 | R$ 1,80 |
| 500 | 1.500 | 500 | 25 | cluster operacional e sharding | 3 | 2 | 12 | 2,5 TB | R$ 2.369 | R$ 4,74 | R$ 1,58 |
| 1.000 | 3.000 | 1.000 | 50 | cluster, filas e dados particionados | 4 | 3 | 28 | 5 TB | R$ 4.492 | R$ 4,49 | R$ 1,50 |

Esses custos são **budgetários**, não cotação de produção. Em 250+ organizações, o custo dominante deixa de ser o VPS unitário e passa a ser alta disponibilidade, operação, suporte, banco gerenciado/replicado, observabilidade e sessões WhatsApp. A topologia atual não deve ser simplesmente replicada 50 vezes.

### Quando escalar

Escalar antes do limite físico quando qualquer sinal ocorrer por 15 minutos:

- CPU acima de 65% sustentada;
- RAM acima de 75% ou swap crescendo;
- PostgreSQL acima de 60% de conexões/pool ou p95 operacional acima de 300 ms;
- Redis acima de 60% de memória ou p95 acima de 10 ms;
- Waxum acima de 70% de file descriptors, aumento de 429/5xx ou queda de áudio;
- backlog de chamadas ou polling do dashboard aumentando;
- storage acima de 70% ou crescimento que não cabe em 6 meses;
- queda de áudio atribuível ao host acima de 1%.

## G. Taxa de pagamento

| Preço bruto | 6% | Líquido a 6% | 8% | Líquido a 8% |
|---:|---:|---:|---:|---:|
| R$ 100 | R$ 6 | R$ 94 | R$ 8 | R$ 92 |
| R$ 199 | R$ 11,94 | R$ 187,06 | R$ 15,92 | R$ 183,08 |
| R$ 299 | R$ 17,94 | R$ 281,06 | R$ 23,92 | R$ 275,08 |
| R$ 348 | R$ 20,88 | R$ 327,12 | R$ 27,84 | R$ 320,16 |
| R$ 499 | R$ 29,94 | R$ 469,06 | R$ 39,92 | R$ 459,08 |
| R$ 999 | R$ 59,94 | R$ 939,06 | R$ 79,92 | R$ 919,08 |

No modelo usei **8%**, para não subestimar o custo.

## H. Pricing baseado em CAC, ROAS e payback

Premissas conservadoras: taxa de pagamento de 8%; COGS recorrente de **R$ 60/mês por organização**, incluindo infraestrutura alocada, e-mail/storage e suporte médio; onboarding de R$ 50 no primeiro mês; churn mensal de referência de 5%; contribuição mensal = preço × 92% − R$ 60; payback = CAC ÷ contribuição mensal.

### Ticket mínimo para payback de 3 meses

| CAC | Ticket mínimo aproximado | Ticket com margem comercial |
|---:|---:|---:|
| R$ 100 | R$ 102 | R$ 149–199 |
| R$ 200 | R$ 138 | R$ 199–249 |
| R$ 300 | R$ 174 | R$ 249–299 |
| R$ 500 | R$ 227 | R$ 299–399 |
| R$ 1.000 | R$ 374 | R$ 499–599 |

Os valores comerciais deixam espaço para onboarding, descontos, inadimplência, impostos não informados e variação de suporte. R$ 100 pode sobreviver em aquisição orgânica, mas não é confortável para tráfego pago com CAC de R$ 500+.

### Payback do ticket recomendado

Para o mínimo recomendado de **R$ 348/mês** — organização + 1 SDR — a contribuição recorrente estimada é R$ 260,16 antes do onboarding.

| CAC | Payback recorrente | Payback incluindo R$ 50 de onboarding |
|---:|---:|---:|
| R$ 100 | 0,4 mês | 0,6 mês |
| R$ 200 | 0,8 mês | 1,0 mês |
| R$ 300 | 1,2 mês | 1,3 mês |
| R$ 500 | 1,9 mês | 2,1 meses |
| R$ 1.000 | 3,8 meses | 4,0 meses |

Com churn de 5%, a vida média esperada é 20 meses. No ticket de R$ 348, a contribuição antes de CAC é aproximadamente R$ 5.203; isso é um modelo, não receita garantida.

## I. Planos recomendados

| Plano | Mensalidade | Inclui | Limite operacional |
|---|---:|---|---|
| Base | R$ 299 + R$ 49/SDR | painel, métricas e 1 número | 1 chamada concorrente |
| Growth | R$ 499 + R$ 69/SDR | automações e suporte prioritário | 3 chamadas concorrentes |
| Scale | R$ 999 + R$ 99/SDR | multi-equipe, SLA comercial e revisão de capacidade | 5 chamadas, sujeito a teste |

Cobrança mínima sugerida: **R$ 348/mês** (Base + 1 SDR). Setup: **R$ 149**, abatível em contrato anual. Para 3 SDRs, o Base fica em R$ 446; para 10 SDRs, R$ 789. Não vender “SDR ilimitado” sem limitar concorrência, polling, linhas e fair use.

> **Eu cobraria R$ 299 por organização + R$ 49 por SDR, com mínimo de R$ 348/mês e setup de R$ 149, porque o seat não gera licença técnica, mas a organização consome capacidade compartilhada, suporte, onboarding, governança e risco de operação WhatsApp.**

Para CAC próximo de R$ 1.000, exigir setup, contrato mínimo de 3 meses ou plano de pelo menos R$ 499. Para tráfego orgânico ou indicação, o Base pode ser testado com desconto controlado; esse desconto não deve virar preço de tabela.

## J. Margem e ponto de equilíbrio

No ticket mínimo de R$ 348:

- receita bruta: R$ 348;
- pagamento a 8%: R$ 27,84;
- receita após pagamento: R$ 320,16;
- COGS recorrente estimado: R$ 60;
- margem de contribuição antes de CAC: **R$ 260,16 / 74,8%**;
- primeiro mês após onboarding de R$ 50: R$ 210,16 de contribuição;
- com CAC de R$ 500: payback ocorre pouco depois de 2 meses.

O break-even puramente técnico do host atual é baixo: com infraestrutura operacional de aproximadamente R$ 228/mês e contribuição de R$ 260 por cliente mínimo, **1–2 organizações** cobrem a infraestrutura. Isso não é o break-even do negócio.

Se houver R$ 3.000/mês de operação/suporte fixo, o break-even aproximado fica em 3.000 / 260 = **12 organizações mínimas**, antes de marketing, impostos, pró-labore e inadimplência. Com 5% de churn, o objetivo saudável é manter 20–25 organizações ativas antes de aumentar investimento em tráfego.

## K. Gargalos prováveis, do primeiro ao último

1. **WhatsApp/Waxum:** limite por linha, bloqueio por rajadas, 429 e instabilidade do gateway não oficial.
2. **Sessões e file descriptors:** cada número e WebSocket consome conexão, memória e descritores; Waxum é um ponto único no Compose.
3. **Estado local das APIs:** duas instâncias podem divergir em sockets de SDR e chamadas ativas; isso aparece antes de uma escala horizontal segura.
4. **Polling do dashboard:** muitas abas abertas geram consultas constantes, mesmo sem novas chamadas.
5. **PostgreSQL:** crescimento de leads, calls, auditoria e índices; importações e métricas filtradas são candidatos a latência.
6. **Redis:** locks, reservas, cache e métricas compartilham a mesma instância; memória e persistência devem ser monitoradas.
7. **Disco/backup:** backup local no mesmo host não cobre perda do host; sem retenção de calls/leads, o crescimento é permanente.
8. **CPU/RAM:** pelo perfil atual e relay sem transcodificação, não parecem ser o primeiro gargalo; a conclusão depende de teste real de Waxum.

## L. Plano de validação antes de vender escala

1. Corrigir o lock global do tick para não incluir o ID da instância, ou designar um worker único.
2. Escolher estratégia de afinidade/ownership para sockets de SDR e chamadas, ou mover esse estado para camada distribuída.
3. Instrumentar CPU, RAM, rede, file descriptors, conexões PG/Redis, NATS, Waxum, erros 429/5xx, latência de áudio e taxa de chamadas concluídas.
4. Testar 5, 10, 20 e 30 chamadas reais simultâneas por 60 minutos, em pelo menos três janelas.
5. Aprovar apenas patamar com CPU <70%, RAM <75%, perda de áudio <1%, falha de plataforma <1% e sem crescimento de backlog.
6. Definir a capacidade comercial como 70% do maior patamar aprovado; revisar mensalmente com métricas reais.

## Fontes de preços e ressalvas

- [Pricing oficial do Resend](https://resend.com/pricing): Free com 3.000 e-mails/mês e limite diário de 100; Pro a US$ 20/mês; Scale a US$ 90/mês; overage Pro de US$ 0,90 por 1.000.
- [Pricing oficial do Sentry](https://sentry.io/pricing/): Developer gratuito; Team a US$ 26/mês; Business a US$ 80/mês.
- [Integrator Host](https://www.integrator.com.br/plano-vps-icp): referência de 4 vCPU, 6 GB e 100 GB; o preço promocional público é diferente dos R$ 44,90 efetivamente informados para este ambiente, por isso usei R$ 44,90.
- Preço do domínio e impostos devem ser confirmados na conta real. SSL não foi tratado como custo recorrente obrigatório porque pode ser gratuito, mas a renovação continua sendo responsabilidade do deploy.

**Conclusão:** o produto pode ter boa margem de infraestrutura, mas só escala com lucro se vender concorrência controlada, cobrar onboarding, manter churn baixo e validar o teto do WhatsApp. O preço não deve ser derivado de R$ 44,90 dividido por 50; deve ser derivado da capacidade real de chamadas simultâneas e do custo de operação por organização.
