# Plano completo de implementação — Stripe, assinaturas e limites por organização

## 1. Objetivo

Integrar o ZapLiga ao Stripe Billing para que o direito de operar o produto seja
determinado pela assinatura da organização (`tenant`), e nunca pela assinatura de
um usuário isolado.

O resultado esperado é:

- a organização precisa ter uma assinatura válida para alterar dados ou operar;
- líderes e SDRs herdam o estado financeiro da organização à qual pertencem;
- sem assinatura válida, os usuários continuam autenticando e consultando os
  dados e métricas que seu papel já permite, mas o tenant fica somente leitura;
- sem assinatura válida, nenhuma chamada automática ou manual nova pode começar;
- cada plano define um limite máximo de SDRs;
- convites, reativações e mudanças de papel não podem ultrapassar esse limite,
  inclusive sob concorrência;
- pagamento, renovação, falha, cancelamento e reativação são refletidos por
  webhooks assinados, idempotentes e reconciliáveis;
- Stripe é a fonte da verdade financeira e o banco local é a projeção usada para
  autorização. A API não consulta o Stripe a cada request.

Os valores comerciais iniciais e os nomes dos planos estão definidos no
documento complementar `docs/plano-planos-entitlements-seats.md`. O código mantém
test/live isolados e o deploy sincroniza o catálogo somente no ambiente
correspondente; os secrets continuam fora do repositório.

## Estado desta entrega

O fluxo de aplicação foi implementado no workspace: projeção local de
entitlement, Checkout/Portal, inbox de webhooks, reconciliação, guards HTTP,
quota concorrente de SDR, barreiras do discador/WebSocket e UI de cobrança.
Backend (49 suites/256 testes), frontend (22 arquivos/54 testes), typecheck,
checagem estrutural e build de produção foram validados.

No Stripe Live do ZapLiga já existem os Products/Prices versionados de Starter,
Growth, Pro e SDR adicional, além do destino de webhook
`https://api.zapliga.com/api/billing/stripe/webhook` com os oito eventos de
billing necessários. A configuração padrão do Customer Portal também existe.
Ainda dependem do ambiente de execução: inserir
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_LIVEMODE=true` e
`STRIPE_PORTAL_CONFIGURATION_ID` no secret manager, executar o deploy (que
aplica migrations e sincroniza o catálogo) e rodar o smoke/E2E Live.
Nenhum deploy de produção foi feito nesta entrega.

## 2. Diagnóstico do sistema atual

O projeto já possui uma base útil:

- backend NestJS, PostgreSQL, Redis e frontend React;
- `tenants`, `tenant_memberships`, papéis `leader`/`sdr` e `super_admin` global;
- `AuthGuard`, `TenantMembershipGuard` e `RolesGuard`;
- rotas tenant-aware, auditoria, convites, WebSocket autenticado e discador por
  tenant;
- `tenants.max_sdrs`, criado em `006_tenant_limits.sql`, com default 500;
- verificações parciais de quota em memberships, aceite de convite e criação do
  perfil SDR;
- corpo bruto da requisição já preservado em `main.ts`, necessário para verificar
  a assinatura dos webhooks do Stripe.

Lacunas que precisam ser resolvidas:

1. Não há SDK, módulo, tabelas ou projeção de cobrança.
2. `tenants.status` mistura ciclo administrativo com acesso ao produto. Hoje um
   tenant que não esteja `active` perde também a leitura, portanto essa coluna não
   deve representar inadimplência.
3. `max_sdrs` é alterado manualmente pelo super admin, não deriva de um plano
   versionado e possui um default comercial arbitrário.
4. A quota atual não reserva convites pendentes e não está centralizada em todos
   os caminhos que transformam alguém em SDR.
5. A checagem não é totalmente segura contra duas inclusões concorrentes.
6. `GET /api/me/sdr` pode criar um registro, quebrando a premissa de que leitura
   não modifica estado.
7. Controllers, WebSocket e o loop do discador ainda não conhecem entitlement de
   cobrança.
8. O frontend não recebe nem representa `accessMode`, plano, uso ou limite.

## 3. Decisões de arquitetura

### 3.1 Separar estado administrativo de estado financeiro

`tenants.status` continua significando ciclo administrativo:

- `active`: tenant existente e acessível;
- `blocked`: bloqueio administrativo/segurança, sem leitura operacional;
- `archived`: encerrado, sem leitura operacional normal.

Cobrança terá estado próprio. Inadimplência nunca mudará `tenants.status` e não
revogará sessões. Assim, um tenant financeiramente restrito permanece visível no
seletor e seus usuários continuam consultando o histórico permitido pelo papel.

### 3.2 Um cliente e no máximo uma assinatura operacional por tenant

- Cada tenant terá um `stripe_customer_id` exclusivo.
- Na primeira versão, haverá no máximo uma assinatura que conceda acesso por
  tenant.
- Um mesmo usuário pode participar de tenants com situações financeiras
  diferentes; a autorização é sempre calculada para o tenant ativo.
- O e-mail de cobrança do Stripe não será usado como identidade de login.

### 3.3 Estados de acesso internos

O produto não deve espalhar enums do Stripe por todo o domínio. Um serviço central
calculará um dos seguintes estados:

| `access_mode` | Efeito no produto |
| --- | --- |
| `full` | leitura, escrita e operação conforme o papel |
| `read_only` | leitura permitida; escrita e novas chamadas bloqueadas |
| `blocked` | tenant bloqueado/arquivado administrativamente |

Motivos separados explicam o estado, por exemplo:

- `active_subscription`;
- `trialing` (somente se testes gratuitos forem habilitados);
- `manual_grant`;
- `no_subscription`;
- `incomplete`;
- `past_due`;
- `unpaid`;
- `paused`;
- `canceled`;
- `subscription_expired`;
- `billing_sync_stale`;
- `tenant_blocked`.

Política inicial, fiel ao requisito “assinatura ativa”:

- `active` concede `full` até `access_until`;
- `trialing` concede `full` somente se o produto adotar trial;
- `cancel_at_period_end=true` continua `full` até o fim do período pago;
- `past_due`, `unpaid`, `paused`, `incomplete`, `incomplete_expired`, `canceled`
  e ausência de assinatura resultam em `read_only`;
- o grace period inicial é zero. A arquitetura aceitará configurá-lo depois sem
  mudar os guards;
- uma concessão manual explícita pode dar `full`, sempre com motivo, autor,
  validade e auditoria.

Para planos pagos sem trial, `invoice.paid` é o evento que avança
`access_until`. Um `customer.subscription.updated` isolado pode restringir ou
encerrar acesso, mas não estende período pago sem confirmação da fatura. Isso
evita interpretar `status=active` como prova de que toda cobrança relevante foi
paga.

### 3.4 Assinatura não é consultada em tempo real por request

Webhooks e reconciliação mantêm uma projeção local. A autorização lê o banco/Redis
local e considera `access_until`, evitando que uma indisponibilidade do Stripe
derrube todas as requisições e evitando acesso indefinido quando um webhook falhar.

### 3.5 Checkout e portal hospedados

Usar Stripe Checkout em `mode=subscription` para contratar e Stripe Customer
Portal para método de pagamento, faturas e cancelamento. A aplicação recebe apenas
URLs temporárias criadas pelo backend; chaves secretas nunca chegam ao navegador.

Na primeira entrega, o portal não permitirá trocar para um plano com limite menor.
Troca de plano só será liberada depois que houver validação de capacidade antes da
mudança. Isso evita um downgrade externo que deixe a organização acima da quota.

### 3.6 O retorno do Checkout não concede acesso

A `success_url` serve apenas para experiência do usuário. O acesso muda somente
depois de webhook verificado ou reconciliação com o Stripe confirmar assinatura
`active`/`trialing` e o período aplicável.

## 4. Matriz de autorização

As permissões atuais por papel continuam valendo. Cobrança é uma condição
adicional, não uma substituição de RBAC.

| Ação | `full` | `read_only` | `blocked` |
| --- | ---: | ---: | ---: |
| Login, logout, segurança da própria conta | sim | sim | sim |
| Ver dados e métricas já permitidos pelo papel | sim | sim | não |
| Baixar exportação já pronta | sim | sim | não |
| Criar/editar/excluir/importar dados do tenant | sim | não | não |
| Alterar flags, integrações, agenda ou configurações | sim | não | não |
| Conectar/reconectar/remover número | sim | não | não |
| Convidar, criar, reativar, remover ou mudar papel | sim | não | não |
| Tornar SDR disponível | sim | não | não |
| Iniciar/pausar discador | sim | não | não |
| Iniciar chamada manual/callback | sim | não | não |
| Criar sessão de Checkout/Portal | líder | líder | suporte |
| Finalizar chamada que já estava em andamento | sim | sim | política de suporte |
| Registrar resultado/pós-atendimento de chamada existente | sim | sim | política de suporte |
| Registrar opt-out/não ligar novamente | sim | sim | sim quando legalmente necessário |

As exceções em `read_only` são estreitas e deliberadas:

- cobrança, para que a organização possa pagar e recuperar acesso;
- conta e segurança, como senha, logout e revogação de sessão;
- aceite legal e solicitações/ações obrigatórias de privacidade e não contato;
- encerramento consistente de uma chamada que começou antes da restrição.

O super admin não ignora silenciosamente o bloqueio financeiro nas rotas normais.
Quando suporte precisar liberar um tenant, deverá criar uma concessão manual
temporária e auditada.

## 5. Modelo de dados

Criar migrations a partir do próximo número livre (no estado atual, `055`):

### 5.1 `billing_plan_versions`

- `id` UUID/text;
- `code` estável, como `base` ou `pro`;
- `version` inteiro;
- `display_name`;
- `status`: `draft`, `active`, `retired`;
- `max_sdrs` inteiro obrigatório para ativar o plano;
- demais limites futuros em colunas explícitas ou `entitlements JSONB` validado;
- `effective_from`, `retired_at`, timestamps;
- unicidade `(code, version)`.

Uma versão usada por assinatura nunca é editada retroativamente. Mudanças de
preço ou limite criam nova versão.

### 5.2 `billing_plan_prices`

- `id`, `plan_version_id`;
- `stripe_price_id` único;
- `livemode` para impedir misturar sandbox e produção;
- `currency`, `billing_interval`, `interval_count`;
- `active`, timestamps.

Nenhum `priceId` enviado pelo frontend é aceito sem lookup nessa allowlist.

### 5.3 `tenant_billing_accounts`

- `(tenant_id, livemode)` PK/FK por ambiente;
- `stripe_customer_id` único;
- `billing_email` apenas para exibição financeira, nunca autenticação;
- `livemode`, timestamps e `last_reconciled_at`.

### 5.4 `tenant_subscriptions`

- `id`, `tenant_id`, `provider='stripe'`;
- `stripe_subscription_id` único;
- `stripe_customer_id`, `stripe_price_id`, `plan_version_id`;
- status bruto do Stripe;
- `current_period_start`, `current_period_end`, `trial_end`;
- `cancel_at_period_end`, `canceled_at`, `ended_at`;
- `latest_invoice_id` e estado resumido da última fatura;
- `access_until` calculado a partir do período confirmado;
- `provider_updated_at`, `last_synced_at`, timestamps;
- índice/constraint que impeça mais de uma assinatura operacional não terminal
  por tenant.

### 5.5 `tenant_entitlements`

Projeção pequena e rápida usada pelos guards:

- `tenant_id` PK;
- `plan_version_id` nullable;
- `access_mode`, `access_reason`, `access_until`;
- `max_sdrs` efetivo;
- `source`: `stripe`, `manual_grant`, `none`;
- `computed_at`, `version` para invalidação de cache.

O limite efetivo vem desta tabela. O `tenants.max_sdrs` atual será mantido apenas
durante a migração e depois removido ou transformado em campo legado sem poder de
autorização.

### 5.6 `billing_webhook_events`

Inbox durável:

- `stripe_event_id` PK;
- `event_type`, `object_id`, `livemode`, `api_version`;
- `received_at`, `processed_at`, `attempts`, `next_attempt_at`;
- `status`: `received`, `processing`, `processed`, `failed`, `dead_letter`;
- `last_error` sanitizado;
- payload necessário criptografado ou com retenção curta.

Além do ID do evento, guardar `(event_type, object_id)` para detectar duplicatas
semânticas quando aplicável.

### 5.7 `billing_manual_grants`

- `id`, `tenant_id`;
- `starts_at`, `expires_at` obrigatórios;
- `max_sdrs` explícito;
- `reason`, `created_by`, `revoked_by`, timestamps.

Não haverá override permanente implícito.

### 5.8 Constraints e proteção de dados

- IDs Stripe são únicos, mas não são segredos; chaves de API e webhook ficam
  somente no secret manager/ambiente.
- Não persistir dados completos de cartão.
- Não registrar payloads ou erros com tokens, URLs temporárias ou dados de
  pagamento desnecessários.
- Índices de fila por `status, next_attempt_at` e de consulta por tenant.
- Todas as FKs tenant-aware devem preservar o isolamento existente.

## 6. Regra de limite de SDRs

### 6.1 O que consome uma vaga

Para não emitir convites impossíveis e não ultrapassar o plano:

```text
used_sdr_seats =
  memberships com role='sdr' e status='active'
  + convites SDR não aceitos, não revogados e não expirados
```

- Membership `blocked` ou `removed` não consome vaga.
- A linha histórica em `sdrs` não consome vaga por si só.
- Líder não consome vaga de SDR.
- Reenvio do mesmo convite não consome uma segunda vaga.

### 6.2 Serviço central de capacidade

Criar `SdrCapacityService` e remover SQL de quota duplicado de
`MembershipsService`, `InvitationsService` e `SdrsController`.

Dentro da mesma transação que adiciona capacidade:

1. adquirir `pg_advisory_xact_lock` por tenant ou bloquear a linha de entitlement
   com `FOR UPDATE`;
2. validar `access_mode='full'`;
3. expirar logicamente convites vencidos;
4. recalcular vagas usadas;
5. comparar com `tenant_entitlements.max_sdrs`;
6. criar convite/membership ou retornar `409 sdr_limit_reached` com
   `used`, `reserved`, `limit` e `available`;
7. registrar auditoria.

Aplicar a verificação em todos os caminhos:

- convite SDR;
- reenvio se a reserva anterior expirou;
- aceite de convite (rechecagem obrigatória);
- criação direta de membership;
- reativação de SDR bloqueado;
- mudança de papel `leader -> sdr`;
- criação/reparo do perfil em `sdrs`.

O endpoint de leitura de capacidade retornará contagem ativa, reservas pendentes,
limite e vagas disponíveis. O frontend desabilita “Adicionar SDR” quando zero,
mas a API continua sendo a proteção real.

### 6.3 Downgrade e redução de limite

Na primeira versão, troca de plano pelo Portal fica desabilitada. Quando for
implementada:

- upgrade pode ser imediato após webhook;
- downgrade deve ser agendado para o próximo ciclo;
- a API recusa o agendamento se `used_sdr_seats` for maior que o novo limite;
- nenhuma pessoa é removida automaticamente;
- inconsistências externas colocam o tenant em `capacity_mismatch`, bloqueiam
  novas vagas e geram alerta para reconciliação, sem apagar dados.

## 7. Backend e integração Stripe

### 7.1 Estrutura sugerida

```text
apps/api/src/infrastructure/stripe/
  stripe.client.ts
  stripe.module.ts

apps/api/src/modules/billing/
  billing.controller.ts
  billing-webhook.controller.ts
  billing.service.ts
  billing-reconciliation.service.ts
  billing-webhook-worker.service.ts
  entitlement.service.ts
  tenant-access.guard.ts
  tenant-action.decorator.ts
  sdr-capacity.service.ts
  dto/
```

Adicionar o SDK oficial `stripe` no workspace da API e fixar explicitamente uma
versão de API revisada. Atualizações da versão do SDK/API exigem teste dos payloads
de webhook antes do deploy.

### 7.2 Endpoints

| Método e rota | Papel | Finalidade |
| --- | --- | --- |
| `GET /api/tenants/:tenantId/billing` | líder/super admin | status, plano, período, limite e uso |
| `POST .../billing/checkout-session` | líder/super admin | criar/reusar Customer e abrir Checkout |
| `POST .../billing/portal-session` | líder/super admin | abrir Customer Portal |
| `POST /api/billing/stripe/webhook` | público + assinatura Stripe | receber eventos |
| `POST .../billing/reconcile` | super admin | reconciliar tenant sob demanda |
| `POST .../billing/manual-grants` | super admin | concessão temporária auditada |
| `DELETE .../billing/manual-grants/:id` | super admin | revogar concessão |

Checkout deve:

- aceitar apenas `planCode`/intervalo conhecidos e resolver `priceId` no servidor;
- reutilizar `stripe_customer_id` sob lock por tenant;
- usar `mode=subscription`;
- incluir `tenant_id` em `client_reference_id` e metadata dos objetos apropriados;
- usar idempotency key estável por tentativa de checkout;
- impedir nova sessão se já existir assinatura operacional ativa ou pendente;
- usar URLs de sucesso/cancelamento de allowlist do servidor.

### 7.3 Webhook seguro e assíncrono

Fluxo do endpoint:

1. ler `request.rawBody` sem transformação;
2. verificar `Stripe-Signature` com `STRIPE_WEBHOOK_SECRET` e SDK oficial;
3. rejeitar assinatura inválida com 400;
4. inserir o evento na inbox com `ON CONFLICT DO NOTHING`;
5. responder 2xx rapidamente;
6. um worker com claim transacional (`FOR UPDATE SKIP LOCKED`) processa a inbox.

Eventos mínimos:

- `checkout.session.completed`;
- `customer.subscription.created`;
- `customer.subscription.updated`;
- `customer.subscription.deleted`;
- `invoice.paid`;
- `invoice.payment_failed`;
- `invoice.payment_action_required`;
- `invoice.finalization_failed`.

O processador não depende da ordem de entrega. Para eventos de assinatura/fatura,
busca a assinatura atual no Stripe quando necessário e recalcula toda a projeção,
em vez de aplicar transições incrementais frágeis. Evento repetido produz o mesmo
resultado.

Cada atualização da projeção ocorre em transação e:

- valida `livemode` contra o ambiente;
- resolve tenant por IDs previamente associados e metadata validada;
- atualiza assinatura e entitlement;
- pausa a geração de novas chamadas ao perder `full`;
- invalida cache/publica mudança para outras instâncias;
- registra auditoria financeira sem dados sensíveis.

Evento com Customer/Subscription desconhecido vai para erro observável/dead-letter,
nunca cria associação a um tenant apenas confiando em e-mail.

### 7.4 Reconciliação

Adicionar worker periódico com lock distribuído:

- reconciliar assinaturas alteradas recentemente e projeções atrasadas;
- consultar diretamente o Stripe e comparar customer, subscription, price,
  status, período e cancelamento;
- corrigir divergências de forma idempotente;
- alertar quando `last_synced_at` exceder o SLA;
- permitir reconciliação manual por tenant/evento;
- manter ferramenta operacional para reprocessar dead letters.

Recomendação inicial: ciclo a cada 15 minutos, alerta após 30 minutos sem sync e
varredura integral diária. Os valores devem ser configuráveis.

## 8. Enforcement HTTP e domínio

### 8.1 Política central e fail closed

Estender o contexto autenticado com:

```ts
tenantAccess: {
  mode: 'full' | 'read_only' | 'blocked';
  reason: string;
  planCode?: string;
  accessUntil?: string;
  maxSdrs?: number;
}
```

Criar `@TenantAction(...)` com categorias:

- `read`;
- `write`;
- `operate`;
- `billing_recovery`;
- `call_finalize`;
- `legal_compliance`.

Regra padrão para rotas tenant-aware:

- `GET`, `HEAD`, `OPTIONS`: `read`;
- `POST`, `PUT`, `PATCH`, `DELETE`: `write`;
- exceções precisam de annotation explícita e teste.

Quando bloqueada, a API responde de forma consistente:

```json
{
  "statusCode": 402,
  "code": "subscription_required",
  "message": "A organização está em modo somente leitura.",
  "billingReason": "past_due",
  "manageBilling": true
}
```

Quota retorna 409 com `code=sdr_limit_reached`.

### 8.2 Inventário obrigatório de mutações

O guard deve cobrir, além dos módulos centrais:

- leads, pastas e importações;
- números, QR/reconexão e configurações;
- discador, agenda, chamadas manuais e callbacks;
- memberships, convites e SDRs;
- campanhas, playbooks e motor de decisão;
- metas, views, retenção e reprocessamentos de métricas;
- integrações e outbound webhooks;
- feature flags, recomendações, experimentos, benchmarks e learning;
- onboarding, compliance e privacidade conforme as exceções definidas;
- ações administrativas executadas no contexto do tenant.

Criar um teste/reflection check que falhe quando uma nova rota tenant-aware de
mutação não possuir política de cobrança. Isso evita que futuros controllers
abram um bypass.

### 8.3 Remover efeitos colaterais de GET

Auditar todas as rotas de leitura. Em especial:

- `GET /api/me/sdr` deixa de criar `sdrs`; criação/reparo migra para fluxo explícito
  protegido e idempotente;
- exports que criam jobs devem usar `POST`, enquanto download de arquivo pronto
  pode continuar `GET`;
- GETs que consultam QR ou serviços externos precisam ser classificados como
  leitura ou operação conscientemente.

### 8.4 Defesa no serviço de domínio

O guard HTTP não basta. `EntitlementService.assertCanOperate(tenantId)` será chamado
antes de qualquer efeito externo ou assíncrono:

- `DialerService.start`;
- `manualCallWithInput` e callback “ligar agora”;
- imediatamente antes de reservar recursos;
- imediatamente antes de enviar uma chamada ao Waxum;
- jobs de campanha que possam originar chamadas;
- criação de ticket WebSocket operacional.

Isso protege chamadas internas, timers e futuros consumidores que não passam por
controller.

## 9. Discador e WebSocket

### 9.1 Transição de `full` para `read_only`

Ao perder acesso:

1. atualizar entitlement em transação;
2. definir `dialer_settings.running=false` com motivo `billing_restricted`;
3. impedir novas reservas no próximo tick;
4. cancelar/liberar reservas locais que ainda não produziram chamada externa;
5. marcar SDRs não ocupados como indisponíveis;
6. invalidar tickets WebSocket ainda não usados;
7. publicar `billing_access_changed` via Redis para todas as instâncias;
8. notificar interfaces abertas.

Chamadas já conectadas não são derrubadas. Elas podem ser encerradas e receber
resultado/pós-atendimento. Chamadas ainda não entregues ao provedor são canceladas;
as já entregues seguem a política de finalização segura e não originam nova
tentativa.

### 9.2 Barreira em cada tick

`tick(tenantId)` deve verificar entitlement depois de adquirir o lock e antes de
selecionar/reservar recursos. Uma segunda verificação ocorre imediatamente antes
do efeito externo, fechando a janela de corrida com um webhook de inadimplência.

`setAvailability(true)` e chamada manual também exigem `full`. Tornar-se
indisponível, desligar/finalizar chamada e registrar resultado continuam possíveis
para limpeza segura.

### 9.3 WebSocket

- `/ws-ticket` de SDR exige `full`.
- O consumo do ticket revalida membership, tenant e entitlement.
- Cada mensagem de `availability`, `identify` operacional ou chamada revalida o
  entitlement ou usa cache curto invalidado por evento.
- Sockets existentes recebem `billing_restricted`; depois de concluir eventual
  chamada, o canal operacional fecha com código próprio.
- O socket de observação do líder pode permanecer para dados em tempo real, mas
  comandos de mutação continuam bloqueados.

## 10. Frontend

### 10.1 Contrato de sessão e estado global

Incluir no tenant retornado por `/api/auth/me` e `/api/me/tenants`:

- `accessMode`, `billingReason`, `accessUntil`;
- `planCode`/nome;
- `maxSdrs`, `usedSdrSeats`, `reservedSdrSeats`;
- `canManageBilling` e `cancelAtPeriodEnd`.

O `AuthProvider` expõe esse estado e um helper central `canMutateTenant`. Após
webhook, a UI atualiza por evento em tempo real ou polling curto da rota de billing.

### 10.2 Experiência somente leitura

- Banner persistente no topo explicando o motivo e a data relevante.
- Para líderes, CTA “Regularizar pagamento” que abre o Portal ou Checkout.
- Para SDRs, mensagem “A operação da organização está temporariamente somente
  leitura; fale com seu líder”, sem expor detalhes financeiros.
- Desabilitar botões, formulários, drag-and-drop, imports, toggles e atalhos de
  teclado com tooltip/mensagem acessível.
- Não esconder dados históricos ou métricas já autorizadas pelo papel.
- Não depender só do estado inicial: ao receber 402, atualizar o contexto, fechar
  modais de mutação e mostrar o banner.
- Não mostrar botão do discador como “Pausar” clicável quando a pausa foi causada
  pela cobrança; exibir `Pausado — assinatura`.

### 10.3 Página “Plano e cobrança”

Para líderes:

- plano atual, situação, renovação/fim do período;
- uso de SDRs `usados + reservados / limite`;
- ação de contratar, regularizar ou gerenciar cobrança;
- aviso de cancelamento agendado;
- instrução clara de que o retorno do Checkout pode levar alguns segundos até o
  webhook confirmar o acesso;
- estados loading, vazio, erro e reconciliação pendente.

Para super admin:

- customer/subscription IDs copiáveis, links seguros ao Dashboard Stripe;
- último webhook/sync, divergências e dead letters;
- reconcile e concessão manual com motivo/expiração.

## 11. Configuração e segurança

Variáveis previstas:

```text
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
STRIPE_API_VERSION
STRIPE_LIVEMODE
STRIPE_PORTAL_CONFIGURATION_ID
BILLING_ENFORCEMENT_MODE=off|shadow|enforce
BILLING_WORKER_ENABLED
BILLING_WORKER_INTERVAL_MS
BILLING_RECONCILE_INTERVAL_MS
BILLING_STALE_AFTER_MS
```

Quando `BILLING_ENFORCEMENT_MODE` fica vazio, o padrÃ£o Ã© `off` em
desenvolvimento/teste e `enforce` em qualquer outro ambiente (inclusive
produÃ§Ã£o). Use `shadow` explicitamente durante um rollout gradual.

Os IDs de Price podem ficar no catálogo do banco com seed administrado e separado
por `livemode`; não devem ser aceitos diretamente do cliente.

Regras:

- falhar o boot de produção se enforcement estiver ativo sem segredos válidos;
- falhar o boot de produção se billing ativo não estiver em Live mode ou sem a
  configuração do Customer Portal;
- verificar assinatura sobre raw body antes de parsear/confiar no evento;
- HTTPS obrigatório, já coerente com o bootstrap atual;
- idempotency keys em criações/alterações Stripe;
- timeouts e retries apenas para erros transitórios;
- sanitizar logs/Sentry;
- princípio de menor privilégio na chave Stripe;
- segredo distinto entre sandbox e produção e rotação documentada;
- não versionar `.env` nem fixtures com payload real de cliente.

## 12. Auditoria e observabilidade

Eventos de auditoria mínimos:

- `billing.customer_created`;
- `billing.checkout_created`;
- `billing.subscription_changed`;
- `billing.access_changed`;
- `billing.payment_failed`;
- `billing.reconciled`;
- `billing.manual_grant_created/revoked`;
- `billing.action_denied` com amostragem para evitar ruído;
- `billing.sdr_limit_denied`;
- `dialer.paused_by_billing`.

Métricas/alertas:

- webhooks recebidos, inválidos, duplicados, processados e em dead-letter;
- idade do evento mais antigo pendente e tempo até projeção;
- falhas e divergências de reconciliação;
- tenants por access mode/reason;
- ações bloqueadas por cobrança;
- tentativas de ultrapassar quota;
- tenants com `full` e sync vencido;
- discador ainda `running` após perda de entitlement;
- chamadas iniciadas depois do instante efetivo da restrição (deve ser zero).

## 13. Testes

### 13.1 Unidade

- matriz de status Stripe -> `access_mode`;
- `cancel_at_period_end`, expiração e eventual grace period;
- plano/preço allowlist;
- cálculo de vagas, reservas e expiração de convites;
- payload padronizado de 402/409;
- transições do discador na perda/retorno do acesso.

### 13.2 Integração backend/banco

- assinatura válida permite mutações; cada estado inválido bloqueia;
- GETs permanecem disponíveis em `read_only` e não escrevem;
- toda rota tenant-aware mutável possui política;
- duas inclusões concorrentes para a última vaga: somente uma vence;
- convite + criação direta concorrentes respeitam a mesma quota;
- bloqueio em convite, aceite, reativação e mudança de papel;
- Webhook com assinatura inválida não persiste nada;
- replay do mesmo evento não duplica efeitos;
- eventos fora de ordem convergem para o estado atual do Stripe;
- customer desconhecido não é associado por e-mail;
- `livemode` incorreto é rejeitado;
- reconciliação corrige projeção divergente;
- isolamento completo entre dois tenants.

### 13.3 Discador/WebSocket

- tenant `read_only` não inicia dialer, chamada manual nem callback;
- tick não reserva e a barreira final não chama o Waxum;
- perda de acesso entre reserva e efeito externo bloqueia a chamada;
- ticket novo é negado e ticket antigo não contorna a regra;
- socket aberto não consegue marcar disponibilidade nem iniciar ação;
- chamada conectada antes da restrição finaliza e registra outcome;
- reativação restaura a capacidade sem iniciar o discador automaticamente.

### 13.4 Frontend/E2E

- líder inadimplente consulta dashboard/métricas e não altera dados;
- SDR inadimplente vê seus dados permitidos, mas não fica disponível nem liga;
- todos os controles de mutação exibem motivo consistente;
- 402 recebido durante modal aberto atualiza a aplicação;
- contratação -> webhook -> `full`;
- falha de pagamento -> `read_only`;
- pagamento recuperado -> `full`;
- cancelamento no fim do período mantém acesso até a data e depois restringe;
- limite de SDR aparece e impede inclusão;
- troca entre tenant pago e não pago não vaza estado.

### 13.5 Stripe sandbox

- Stripe CLI para encaminhar e repetir webhooks assinados;
- cartões de teste para sucesso, falha e autenticação necessária;
- Test Clocks/Simulations para renovação, falha, retry e cancelamento;
- smoke test separado em staging com Checkout e Portal reais do sandbox;
- CI normal usa fake determinístico e fixtures sanitizadas; não depende da rede do
  Stripe.

## 14. Migração e rollout

### Fase 0 — decisões e ADR

Registrar em ADR:

- nomes, preços, moeda, periodicidades e `max_sdrs` de cada plano;
- existência de trial;
- grace period de `past_due` (default deste plano: zero);
- cancelamento imediato ou no fim do período;
- política tributária/fiscal e dados de cobrança;
- efeito de reembolso, chargeback/disputa e crédito manual sobre o acesso;
- quais líderes administram cobrança;
- política para tenants atuais e contratos assistidos.

### Fase 1 — fundação sem enforcement

- criar migrations e módulo Stripe/Billing;
- criar catálogo em `draft` sem inventar limites;
- implementar projeção, policy e capacidade;
- atualizar contratos de API;
- `BILLING_ENFORCEMENT_MODE=off`.

### Fase 2 — Checkout, Portal, webhooks e reconciliação

- configurar produtos/preços no sandbox;
- implementar endpoints e worker;
- validar replay, ordem invertida e falhas;
- criar dashboard operacional de billing.

### Fase 3 — enforcement em sombra

- `shadow`: policy calcula e registra o que bloquearia, mas não bloqueia;
- corrigir rotas sem classificação e GETs com efeitos colaterais;
- comparar tenant, ação e estado sem registrar dados sensíveis;
- exigir zero bypass conhecido antes de avançar.

### Fase 4 — frontend e piloto

- entregar página de cobrança, banners e controles desabilitados;
- atribuir aos tenants legados concessão manual temporária com o limite atual,
  impedindo corte acidental;
- pilotar um tenant interno e depois dois clientes acompanhados;
- não habilitar cadastro público pago antes do piloto.

### Fase 5 — enforcement

- ativar `enforce` por tenant/feature flag antes do global;
- confirmar webhook, reconciliação e alertas;
- migrar contratos existentes para Stripe ou manter concessão manual com validade;
- ativar criação de novos tenants como `read_only/no_subscription` até pagamento;
- habilitar cadastro self-service somente depois do gate completo.

### Fase 6 — limpeza

- remover dependência de `tenants.max_sdrs` após todas as projeções estarem
  preenchidas;
- atualizar ADR 004, README, catálogo de auditoria e runbooks;
- manter migrations somente de ida.

## 15. Rollback

- Alterar enforcement de `enforce` para `shadow` é o rollback funcional rápido;
  webhooks continuam sendo ingeridos e reconciliados.
- Desabilitar Checkout/Portal não deve apagar Customers, subscriptions ou eventos.
- Não reverter migrations destrutivamente; adicionar migrations corretivas.
- Reativar escrita por rollback não inicia o discador automaticamente.
- Se webhook falhar, usar reconciliação e reprocessamento da inbox, não alterar
  entitlement manualmente sem trilha.
- Qualquer concessão emergencial precisa expirar e registrar autor/motivo.

Antes de build, deploy, restart ou mudança em produção, seguir integralmente
`docs/deploy-runbook.md`; em especial, nunca compilar Rust/Waxum na VPS.

## 16. Critérios de aceite finais

- [ ] Tenant administrativamente ativo e financeiramente restrito consegue fazer
      login e consultar dados/métricas permitidos pelo papel.
- [ ] O mesmo tenant recebe 402 em toda mutação não isenta.
- [ ] SDR desse tenant não obtém/usa canal operacional, não fica disponível e não
      inicia chamada manual ou callback.
- [ ] O discador não produz chamada nova após a restrição, mesmo com corrida entre
      webhook, tick e efeito externo.
- [ ] Chamada anterior pode ser finalizada sem corromper histórico, outcome ou
      opt-out.
- [ ] Assinatura ativa restaura escrita/operação sem intervenção manual e sem
      iniciar o discador automaticamente.
- [ ] `cancel_at_period_end` preserva acesso somente até o fim confirmado.
- [ ] Limite de SDR vem da versão do plano e é respeitado em todos os caminhos.
- [ ] Duas inclusões concorrentes nunca ultrapassam a última vaga.
- [ ] Convites pendentes reservam vaga e expiração/revogação a libera.
- [ ] Nenhum retorno de Checkout, e-mail ou parâmetro do frontend concede acesso.
- [ ] Webhooks inválidos são rejeitados; duplicados e fora de ordem convergem sem
      efeitos duplicados.
- [ ] Reconciliação detecta/corrige divergência e possui alerta de atraso.
- [ ] Super admin só contorna cobrança por concessão temporária auditada.
- [ ] Testes unitários, integração, multitenant, concorrência, WebSocket, frontend
      e E2E estão verdes.
- [ ] Sandbox cobre contratação, renovação, falha, recuperação e cancelamento.
- [ ] Documentação e runbooks de suporte, cobrança, incidente e rollback estão
      atualizados.

## 17. Entregáveis por área

| Área | Entregável verificável |
| --- | --- |
| Produto/Financeiro | ADR e catálogo com preço, ciclo e `max_sdrs` definidos |
| Banco | migrations, backfill, constraints e projeção de entitlement |
| Backend | módulo Billing/Stripe, guards, capacity service e reconciliação |
| Operação | barreiras no start, tick, efeito Waxum e WebSocket |
| Frontend | página de cobrança, modo somente leitura e tratamento de 402/409 |
| Segurança | assinatura raw-body, idempotência, allowlists e segredos separados |
| Qualidade | matriz de testes, fake Stripe no CI e Test Clocks em sandbox |
| Suporte | painel de sync/dead-letter, concessão temporária e runbooks |

## 18. Ordem recomendada do backlog

1. Aprovar ADR de estados de acesso e política `past_due`.
2. Criar migrations `billing_*` e backfill sem enforcement.
3. Implementar `EntitlementService` e testes da matriz.
4. Centralizar `SdrCapacityService` e testes concorrentes.
5. Implementar Stripe client, Checkout e Portal.
6. Implementar webhook inbox/worker e reconciliação.
7. Classificar todas as rotas tenant-aware e remover GETs com escrita.
8. Proteger serviços do discador, efeito Waxum e WebSocket.
9. Entregar contrato de sessão, página Billing e modo somente leitura.
10. Rodar shadow mode e fechar bypasses.
11. Migrar tenants legados com concessões temporárias controladas.
12. Validar sandbox/Test Clocks, pilotar e ativar enforcement progressivo.

## 19. Referências oficiais do Stripe

- [Como funcionam assinaturas e seus estados](https://docs.stripe.com/billing/subscriptions/overview)
- [Webhooks de assinaturas e controle de acesso](https://docs.stripe.com/billing/subscriptions/webhooks)
- [Checkout para assinaturas](https://docs.stripe.com/payments/checkout/build-subscriptions)
- [Customer Portal](https://docs.stripe.com/customer-management/integrate-customer-portal)
- [Webhooks: assinatura, duplicatas, ordem e processamento assíncrono](https://docs.stripe.com/webhooks)
- [Idempotência na API](https://docs.stripe.com/api/idempotent_requests)
- [Test Clocks/Simulations](https://docs.stripe.com/billing/testing/test-clocks)
