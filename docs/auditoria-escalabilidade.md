# Auditoria de escalabilidade — ZapCall/ZapLiga

Data: 2026-08-29
Escopo: `apps/api` (NestJS, SQL cru via `pg`), `apps/web` (SPA/nginx), integração Waxum (WhatsApp)/NATS, Redis, Postgres, docker-compose.

Achados verificados linha a linha (não só inferidos). Cada item cita `arquivo:linha`.

## Contexto que muda a leitura de tudo abaixo

O teto real do produto é o **WhatsApp**, não a infraestrutura. Contas levam flag (`463 MissingTcToken`) por **rajada de chamadas**, não por volume total (ver `[[zapcall-dialer-architecture]]` na memória do projeto). Ou seja: o sistema não escala "ligando mais rápido" — escala **adicionando mais números/contas aquecidas**, com cadência espaçada por número. O teto sustentável de chamadas frias por conta/dia ainda não foi medido — é bloqueador de modelo de negócio, não de código, e deveria ser resolvido antes de otimizar a infra.

---

## 1. A API tem duas réplicas no compose; as dependências continuam single-node

- `docker-compose.yml` define `api-a` e `api-b`, com balanceamento no Nginx. Postgres, Redis, NATS e Waxum continuam sendo instâncias únicas, tudo em `127.0.0.1`.
- `apps/api/Dockerfile:16` — `CMD ["node", "apps/api/dist/main.js"]`, sem cluster/PM2.
- `apps/api/src/main.ts:26` — o WebSocket dos SDRs é anexado a cada processo HTTP (`app.get(SdrGateway).attach(...)`).

Isso melhora a disponibilidade HTTP, mas não torna o estado de chamadas e sockets compartilhado. Um crash do processo ainda derruba as ligações e SDRs conectados àquela réplica; a seção 2 detalha o risco residual.

## 2. Estado crítico vive só na memória do processo — bloqueia scale-out horizontal

Se no futuro subirem 2+ instâncias da API (redundância ou capacidade), isto quebra:

- `apps/api/src/modules/dialer/dialer.service.ts:44` — `active: Map<callId, CallResource>` guarda os sockets de mídia/browser de cada ligação em andamento. Não reconstruível em outro processo.
- `apps/api/src/modules/sdrs/sdr.gateway.ts:14-16` — todo o registro de SDRs conectados (`controls`, `sessions`, `tenantBySdr`) é um `Map` local. Se o SDR estiver numa instância e a ligação for despachada por outra, `isConnected()`/`getSocket()` não o encontram — o discador trata como offline.
- `dialer.service.ts:46` — buffer de logs do discador (`logs: any[]`) é só local; painel de logs mostraria visão parcial com múltiplas instâncias.
- `dialer.service.ts:50` — contador de falhas consecutivas por linha (`lineFailures`, usado na auto-quarentena 463) reseta por instância; a quarentena ficaria menos sensível, dividida entre processos.
- `modules/auth/auth.guards.ts:42` — `recentAdminAccess` (debounce de log de auditoria de super admin) duplicaria registros, um por instância.
- `modules/numbers/numbers.controller.ts:16` — `qrRequests` (de-duplicação de busca de QR code) só funciona por instância.

O próprio time já registrou essa lacuna: `docs/multi-tenant-plan.md:208` — *"Para produção, o tick deverá usar lock distribuído no Redis ou ser executado por um worker único, evitando que múltiplas instâncias da API processem a mesma fila."* O lock distribuído do tick já existe (`dialer.service.ts:478`), mas o registro de sockets/SDR ainda não tem equivalente.

**Conclusão prática: hoje dá para rodar 2 réplicas para HTTP, mas o failover de SDR/mídia e a distribuição de eventos em tempo real ainda não são transparentes.**

## 3. Deploy/restart: impacto global reduzido, mas ainda exige smoke de produção

Status em 01/09/2026: os dois problemas de ciclo de vida descritos abaixo foram
corrigidos no código. `main.ts` habilita graceful shutdown e as rotinas de
recuperação agora verificam a instância viva no Redis e atualizam cada registro
com seu próprio `tenant_id`. O risco residual é operacional: um deploy ainda
desconecta sockets da instância substituída e deve ser validado com uma chamada
autorizada em staging.

Achado novo, combina dois problemas:

- `resetStaleSdrPresence()` consulta e atualiza cada SDR com `tenant_id` e `id`,
  preservando o isolamento entre empresas.
- `recoverInterruptedCalls()` só recupera chamadas cuja instância não está viva,
  evitando que uma réplica encerre chamadas pertencentes à outra.
- `apps/api/src/main.ts` chama `enableShutdownHooks(['SIGTERM', 'SIGINT'])`,
  permitindo o encerramento controlado do discador durante deploy.

O risco de deploy não está eliminado: conexões WebSocket são locais ao processo
e serão refeitas pelo navegador. O Gate B deve confirmar que uma chamada ativa,
um SDR e o painel operacional se recuperam como esperado após a troca de uma
réplica.

## 4. O tick de 1s escala linearmente com o número de tenants

- `dialer.service.ts:63` — `setInterval(tickAllTenants, 1000)` varre todos os tenants ativos a cada segundo; cada tick faz lock Redis + queries SQL + chamadas HTTP ao Waxum.
- Com 2+ instâncias, ambas tentam tickar todos os tenants todo segundo; o lock Redis (`dialer.service.ts:478`) impede dupla discagem, mas o overhead de lock/query é duplicado à toa.
- Não quebra com a base atual de tenants, mas é o primeiro lugar a olhar se o nº de contas ativas crescer uma ordem de grandeza. Nesse ponto vale considerar sharding de tenants por worker em vez de "todo processo tickando todo mundo".

## 5. Dashboard faz polling pesado contra o backend — eixo de escala mais imediato que o tick

- `apps/web/src/app/App.tsx:76` — a cada **3 segundos**, toda aba de leader/admin aberta dispara **6 a 8 chamadas HTTP em paralelo**: `/api/dialer/status`, `/api/numbers`, `/api/lead-folders`, `/api/sdrs`, `/api/calls`, `/api/dialer/logs`, mais `leads`/`metrics` da pasta selecionada. Aba de SDR dispara 2 (`/api/dialer/sdr-status`, `/api/me/sdr`).
- Nenhum desses endpoints tem cache — só métricas tem guard de 20s (`metrics-query-guard.service.ts:18-27`). `dialer.controller.ts:12-14` (`status`, `sdr-status`, `logs`) vai direto ao Postgres a cada chamada.
- **Escala com o número de abas de painel abertas simultaneamente, não com o volume de ligações.** Irrelevante hoje; com dezenas de tenants tendo 2-3 pessoas com o painel aberto o dia todo, vira carga constante e crescente no Postgres só de "gente olhando a tela".
- O frontend em si (SPA estático via nginx, `apps/web/Dockerfile`) é stateless e escala trivialmente por réplica/CDN — o problema não é servir o front, é o padrão de polling contra o back.

**Correção sugerida:** reaproveitar o canal WebSocket que já existe para SDR (push de eventos) para leader/admin também, ou, no mínimo, aplicar o mesmo cache curto de Redis já usado em métricas nos endpoints `status`/`numbers`/`calls`/`logs`.

## 6. Waxum é um ponto único de contenção arquitetural

- `apps/api/src/infrastructure/waxum/waxum.client.ts:16,32-37` — **todas** as chamadas HTTP ao Waxum, de todos os tenants, passam por uma única fila em memória (`requestChain`) com throttle mínimo de 250ms entre requisições (deliberado, evita 429, mas é serialização global). Cresce o nº de tenants/números, cresce a fila, cresce a latência de qualquer ação dependente do Waxum (criar sessão, pegar QR code, checar status).
- Só existe **uma** instância de Waxum configurada (`WAXUM_URL` único, sem sharding). Se o volume de números/sessões WhatsApp crescer muito, o Waxum único vira gargalo antes do Node ou do Postgres.
- O relay de áudio (`openMedia()`, `waxum.client.ts:124-127`) abre WebSocket direto ao Waxum por ligação, fora da fila HTTP — não sofre esse throttle.

## 7. Relay de áudio: passthrough puro, sem transcodificação — bom para CPU, sem backpressure

- Confirmado: encaminhamento binário direto sem processamento (`media.send(data, {binary:true})` e `browser.send(data, {binary:true})`, `dialer.service.ts:785,840`). Custo de CPU por ligação simultânea é baixo — não deve ser o gargalo de concorrência de chamadas por instância.
- Nenhum dos dois lados verifica `bufferedAmount` antes de mandar o próximo frame (sem backpressure). Sob rede instável ou pico de concorrência pode acumular memória por ligação em vez de aplicar backpressure. Não urgente nos volumes atuais; monitorar se a concorrência de chamadas simultâneas crescer bastante.

## 8. Banco de dados — bem cuidado, sem alarmes graves

- ORM: nenhum, SQL cru via `pg.Pool` (`database.service.ts:15`) — pool **sem `max` configurado**, cai no default do driver (10 conexões por processo). Vale setar explicitamente e dimensionar contra o `max_connections` do Postgres se subirem mais instâncias/workers.
- Migrations aplicadas com `pg_advisory_lock` (`database.service.ts:40-73`) — seguro mesmo com múltiplas instâncias subindo ao mesmo tempo.
- Índices nas colunas quentes existem e fazem sentido: `(tenant_id, status, next_eligible_at)` em leads, `(tenant_id, created_at DESC)` em calls, índices compostos dedicados para métricas (`020_metrics_query_indexes.sql`).
- N+1 real encontrado: importação de CSV de leads (`lead-folders.service.ts:195-205`) — um INSERT/UPDATE por linha, até 50.000 linhas por importação, dentro de uma única transação. Funciona, mas uma importação grande pode demorar e segurar a transação aberta por muito tempo. Candidato a `INSERT ... UNNEST`/multi-row se virar reclamação de usuário.
- `syncNumberStatuses` (`dialer.service.ts:609-623`) faz uma chamada HTTP ao Waxum + um UPDATE por número, a cada 15s por tenant — escala com nº de números por tenant, não é grave nos volumes atuais.
- Multi-tenancy é isolamento **apenas em nível de aplicação** (todo `WHERE tenant_id = $1` manual, guards `TenantMembershipGuard`/`RolesGuard`), sem Postgres RLS (`docs/security-audit/generate_report.py:73`). Sem overhead de `SET` de sessão RLS na pool de conexões, mas a correção do isolamento depende 100% de nenhuma query esquecer o filtro — já auditado à parte em `docs/security-audit/`.

## 9. Redis — bem desenhado, já pronto para múltiplas instâncias

- `infrastructure/redis/redis.service.ts:4-16` — Lua script de `reserve`/`release` (limites globais e por número via `ZCARD`, locks de lead/SDR/número/sessão Waxum via `EXISTS`) roda atomicamente dentro do Redis; não há race condition apesar do padrão check-then-act.
- Também usado para: lock distribuído do tick (`acquireLock`/`releaseLock`), cache de LID do WhatsApp (30 dias TTL), cache de métricas (20s) e rate limit por tenant+usuário (30 req/10s) em `metrics-query-guard.service.ts`.
- Essa é a peça que já está corretamente pronta para múltiplas instâncias da API — ao contrário do registro de sockets do SDR (item 2).

## 10. Falta de rede de segurança para mudanças em produção

- Núcleo do discador (`dialer.service.ts`, ~990 linhas) sem testes automatizados além das regras puras em `dialer.rules.ts` — que, confirmado, **não são usadas** pelo serviço; a lógica real de elegibilidade/cooldown/capacidade está duplicada em SQL dentro do próprio `dialer.service.ts`.
- Sem métricas/APM/observabilidade (Sentry etc.) configurados.
- Não é "escalabilidade" no sentido de capacidade, mas é o que vai doer ao tentar escalar rápido: qualquer mudança no motor de discagem hoje só é validada manualmente.

---

## Prioridades recomendadas

1. **Validar reconexão e continuidade operacional em deploy** (itens 2+3) — o ciclo de vida foi corrigido, mas os sockets continuam sendo estado local e precisam de evidência em staging.
2. **Trocar o polling de 3s do dashboard por push via WebSocket**, ou aplicar cache curto (Redis) nos endpoints `status`/`numbers`/`calls`/`logs` (item 5) — é o que vai doer primeiro conforme cresce o nº de tenants com painel aberto, antes mesmo do volume de ligações.
3. **Medir o teto de chamadas por conta WhatsApp** (pendente, ver `[[zapcall-testes-pendentes]]`) — é o limite de negócio real, decide se o modelo SaaS fecha economicamente.
4. Registro de SDR/mídia em memória (item 2) — só vira bloqueador quando decidirem rodar 2+ instâncias por redundância.
5. Configurar `max` explícito na pool do Postgres e considerar sharding do tick por tenant (item 4) — relevante só se a base de tenants ativos crescer uma ordem de grandeza.
6. Testes automatizados no `dialer.service.ts` antes de qualquer refactor de escala (item 10).
