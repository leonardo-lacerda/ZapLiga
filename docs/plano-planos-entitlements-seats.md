# Plano de implementação — planos, recursos automáticos e seats de SDR

**Data:** 10/09/2026  
**Status:** implementado no código; migrations locais, Products/Prices e o webhook Live do ZapLiga já foram validados; falta apenas inserir os secrets no ambiente e executar o smoke live  
**Dependência:** complementa `docs/plano-integracao-stripe.md` e parte da integração
Stripe já existente no workspace.

## 1. Objetivo

Fazer o plano contratado pela organização controlar automaticamente:

- quais recursos do ZapLiga estão disponíveis;
- quantos SDRs a organização pode manter ativos ou reservar por convite;
- quantos seats adicionais foram contratados;
- limites comerciais de leads e do histórico de métricas;
- o que acontece em upgrade, downgrade, cancelamento ou falha de pagamento.

Hoje os recursos são habilitados manualmente pelo super admin por meio de feature
flags. O estado desejado é que o catálogo comercial seja a fonte dessas permissões:
pagamento confirmado ativa o plano e seus recursos; perda de acesso financeiro
coloca a organização em modo somente leitura; alteração manual passa a existir
somente como exceção temporária, justificada e auditada.

## 2. Decisão comercial proposta

### 2.1 Catálogo inicial

| Plano | Mensal | Anual | SDRs incluídos | Limite total |
| --- | ---: | ---: | ---: | ---: |
| Starter | R$ 89,90 | R$ 899,00 | 2 | 2 |
| Growth | R$ 249,90 | R$ 2.499,00 | 5 | 5 |
| Pro | R$ 599,90 | R$ 5.999,00 | 10 | 10 |
| Enterprise | sob consulta | contrato anual | 100 ou mais | customizado |

O anual equivale aproximadamente a dez mensalidades. Os valores devem ser
versionados: clientes existentes permanecem no preço contratado e uma mudança de
tabela cria novos Prices/versões, nunca altera retroativamente o contrato.

### 2.2 Seat adicional

- mensal: **R$ 19,90 por SDR adicional**;
- anual: **R$ 199,00 por SDR adicional**;
- o adicional só pode ser contratado junto de um plano-base ativo;
- a quantidade cobrada é `max(0, total_contratado - sdrs_incluidos_no_plano)`;
- o limite efetivo é `sdrs_incluidos + seats_adicionais_pagos`;
- o limite efetivo nunca pode ultrapassar o teto comercial do plano.

Nos planos atuais, o número incluído coincide com o teto (2/5/10). Portanto,
o botão de adicionar SDR permanece bloqueado ao atingir o teto; o adicional de
R$ 19,90 fica pronto para tiers futuros com capacidade extra entre incluídos e
teto comercial.

Exemplos:

| Situação | Cálculo | Total mensal |
| --- | --- | ---: |
| Starter com 2 SDRs | R$ 89,90 + 0 adicionais | R$ 89,90 |
| Growth com 5 SDRs | R$ 249,90 + 0 adicionais | R$ 249,90 |
| Pro com 10 SDRs | R$ 599,90 + 0 adicionais | R$ 599,90 |

### 2.3 R$ 19,90 faz sentido?

Faz sentido **como preço de lançamento para um seat adicional**, não como unidade
principal de monetização.

O relatório interno de custos mostra que o cadastro de mais um SDR não possui
licença externa direta e que o custo marginal sem chamada é próximo de zero. O
custo real vem de chamadas simultâneas, sessões WhatsApp, armazenamento, suporte e
onboarding. Após uma taxa de pagamento conservadora de 8%, R$ 19,90 deixa cerca de
R$ 18,31 antes de impostos e suporte.

Ao mesmo tempo, R$ 19,90 é agressivo frente a referências públicas: há discador
brasileiro anunciado a cerca de R$ 168 por operador, e produtos internacionais de
sales engagement partem de dezenas de dólares por usuário/mês. Portanto, o valor
é defensável somente porque:

- existe uma mensalidade-base por organização;
- o plano limita capacidade operacional, não apenas usuários cadastrados;
- onboarding assistido não está incluído gratuitamente no Starter mensal;
- números WhatsApp pertencem ao cliente;
- o preço será reavaliado com dados reais de suporte, churn e concorrência.

Recomendação: lançar a R$ 19,90, registrar esse Price como versão `v1` e revisar
após 90 dias ou 30 organizações pagantes. Se o suporte médio ou a concorrência por
seat forem maiores que o previsto, criar uma nova versão a R$ 29,90 para novos
clientes, preservando contratos antigos.

### 2.4 Setup e onboarding

- Starter mensal: onboarding self-service; assistência opcional cobrada à parte;
- Growth e Pro anuais: uma sessão de implantação pode ser incluída;
- setup assistido avulso recomendado: R$ 149,00;
- Enterprise: implantação e SLA definidos em proposta.

Isso evita que o primeiro mês de R$ 89,90 seja consumido por uma hora ou mais de
trabalho humano.

## 3. Matriz de recursos

### 3.1 Recursos comuns a todos os planos pagos

- autenticação, organizações, líderes e SDRs;
- discador automático e ligações manuais;
- pool de números WhatsApp;
- leads, pastas e importação CSV;
- histórico de chamadas e resultados;
- callbacks e agenda de operação;
- métricas essenciais do time;
- onboarding dentro do produto;
- privacidade, LGPD e listas de supressão;
- página de cobrança, Checkout e Portal;
- leitura dos próprios dados durante restrição financeira.

### 3.2 Diferenças comerciais

| Capacidade | Starter | Growth | Pro | Enterprise |
| --- | --- | --- | --- | --- |
| SDRs incluídos | 2 | 5 | 10 | customizado |
| Teto total de SDRs | até 2 | até 5 | até 10 | customizado |
| Leads armazenados | 25 mil | 250 mil | 1 milhão | customizado |
| Histórico de métricas | 90 dias | 365 dias | 730 dias | customizado |
| Campanhas versionadas | — | incluído | incluído | incluído |
| Integração de leads por API/webhook | — | incluído | incluído | incluído |
| Motor de decisão de fila | — | incluído | incluído | incluído |
| Recomendações operacionais | — | incluído | incluído | incluído |
| Saúde da operação | resumo básico | completo | completo | completo |
| Analytics learning | — | — | incluído | incluído |
| Experimentos A/B | — | — | incluído | incluído |
| Benchmarks privados | — | — | incluído | incluído |
| Relatórios avançados | — | básico | completo | customizado |
| Suporte | padrão | prioritário | prioritário | SLA dedicado |

Não há limite comercial fixo de chamadas simultâneas por plano. A capacidade real
continua sujeita a teste de carga Waxum/WhatsApp, saúde das linhas, limites
técnicos e fair use. Qualquer teto operacional temporário deve ser tratado como
controle de infraestrutura e comunicado separadamente do catálogo comercial.

### 3.3 Mapeamento para capacidades existentes

| Chave interna | Starter | Growth | Pro | Enterprise |
| --- | ---: | ---: | ---: | ---: |
| `schedule_enforcement` | sim | sim | sim | sim |
| `callbacks` | sim | sim | sim | sim |
| `privacy_requests` | sim | sim | sim | sim |
| `onboarding` | sim | sim | sim | sim |
| `campaigns` | não | sim | sim | sim |
| `decision_engine` | não | sim | sim | sim |
| `recommendations` | não | sim | sim | sim |
| `operation_health` | resumo | sim | sim | sim |
| `analytics_learning` | não | não | sim | sim |
| `experiments` | não | não | sim | sim |
| `benchmarks` | não | não | sim | sim |
| `lead_ingestion_api` | não | sim | sim | sim |
| `advanced_reports` | não | básico | sim | sim |

`operation_health=resumo` e `advanced_reports=básico` mostram que um entitlement
não deve ser apenas booleano. O contrato deve aceitar níveis (`none`, `basic`,
`full`) e valores numéricos.

## 4. Modelo de cobrança no Stripe

### 4.1 Produtos e Prices

Criar quatro produtos comerciais:

1. `ZapLiga Starter`;
2. `ZapLiga Growth`;
3. `ZapLiga Pro`;
4. `ZapLiga SDR adicional`.

Enterprise permanece por proposta até o fluxo comercial estar definido.

Cada plano-base terá Price mensal e anual. O produto `SDR adicional` terá Price
recorrente mensal de R$ 19,90 e anual de R$ 199,00, com cobrança licenciada por
quantidade.

Uma assinatura terá:

- item 1: plano-base, quantidade 1;
- item 2: seat adicional, quantidade N, omitido quando N é zero.

O Stripe reúne os itens recorrentes compatíveis em uma única assinatura e fatura.
Todos os itens devem usar BRL e o mesmo intervalo. Quantidade no subscription item
é o modelo próprio do Stripe para licenciamento por assento.

### 4.2 Metadata operacional

Produtos e Prices recebem metadata para inspeção, mas a aplicação não confia nela
para autorizar acesso:

```text
zapliga_kind=base_plan|sdr_seat
zapliga_plan_code=starter|growth|pro
zapliga_plan_version=1
zapliga_catalog=2026-09
```

A autorização continua resolvendo Price IDs por allowlist no banco. Metadata
ajuda suporte e conciliação, mas não substitui o catálogo versionado.

### 4.3 Checkout

O usuário escolhe plano e total desejado de SDRs. A API:

1. valida o plano e o intervalo;
2. valida `totalSdrs >= includedSdrs` e `<= hardSdrCap`;
3. calcula `extraQuantity`;
4. resolve os dois Price IDs no servidor;
5. cria Checkout com plano-base e, se necessário, item de seats;
6. grava `tenant_id`, `plan_code` e total solicitado em metadata;
7. não concede acesso pelo retorno do navegador;
8. espera `invoice.paid` e a projeção do webhook.

O frontend nunca envia Price ID ou valor monetário.

### 4.4 Alteração de seats

Adicionar seats:

- líder escolhe novo total na página de cobrança;
- API calcula diferença e exibe prévia de pró-rata;
- após confirmação, atualiza a quantidade do item de seat;
- usar atualização pendente/pagamento confirmado para não conceder seat sem
  cobrança bem-sucedida;
- webhook `invoice.paid` recalcula o limite efetivo;
- duas solicitações concorrentes usam idempotency key e lock por tenant.

Reduzir seats:

- negar se `SDRs ativos + convites pendentes > novo limite`;
- exibir exatamente quais convites/membros impedem a redução;
- agendar redução para o próximo ciclo, sem remover usuários automaticamente;
- manter o limite atual até o Stripe confirmar a mudança;
- cancelar a alteração pendente se o tenant voltar a exceder o novo limite antes
  da renovação;
- registrar autor, quantidade anterior/nova e data efetiva.

Na primeira versão, o Customer Portal não altera plano nem quantidade. Ele cuida
de cartão, dados de cobrança, faturas e cancelamento. Upgrade/downgrade e seats
ficam na aplicação para aplicar as validações de capacidade.

### 4.5 Mudança de plano

Upgrade:

- imediato, com prévia e pró-rata;
- recalcular quantidade adicional a partir dos seats totais desejados;
- liberar recursos novos somente após confirmação financeira/projeção;
- nunca iniciar o discador automaticamente.

Downgrade:

- validar SDRs, números, leads e demais limites antes de aceitar;
- não apagar dados que excedam o novo plano;
- agendar para o fim do ciclo;
- ao efetivar, bloquear novas inclusões e deixar dados excedentes somente leitura
  até o cliente reduzir o uso;
- manter histórico dos recursos premium já utilizados, sem permitir novas
  mutações nesses módulos.

## 5. Modelo de dados

Criar uma migration posterior à `055_billing_subscriptions.sql`, sem editar uma
migration já aplicada em qualquer ambiente.

### 5.1 Estender `billing_plan_versions`

Adicionar:

- `included_sdrs INTEGER NOT NULL`;
- manter `max_sdrs` como teto total do plano;
- `feature_entitlements JSONB NOT NULL`;
- `limit_entitlements JSONB NOT NULL`;
- `service_level JSONB NOT NULL` para suporte/onboarding/SLA;
- constraint `included_sdrs <= max_sdrs`;
- validação de schema ao publicar uma versão.

Exemplo Starter:

```json
{
  "features": {
    "schedule_enforcement": "full",
    "callbacks": "full",
    "privacy_requests": "full",
    "onboarding": "full",
    "campaigns": "none",
    "decision_engine": "none",
    "recommendations": "none",
    "operation_health": "basic",
    "analytics_learning": "none",
    "experiments": "none",
    "benchmarks": "none",
    "lead_ingestion_api": "none",
    "advanced_reports": "none"
  },
  "limits": {
    "included_sdrs": 5,
    "hard_sdr_cap": 14,
    "max_leads": 25000,
    "retention_days": 90
  }
}
```

`retention_days` é o período em que o ZapLiga mantém o histórico usado para
métricas e auditoria operacional: mudanças de etapa dos leads, disponibilidade
dos SDRs, status das linhas, agregações e exportações. Ao fim do prazo, esses
registros ficam elegíveis para expurgo conforme a política de retenção; leads e
chamadas não são removidos por essa regra. Números WhatsApp e chamadas não têm
limite comercial fixo por plano: a proteção da infraestrutura continua sendo
feita por capacidade, saúde das linhas, limites técnicos e fair use.

### 5.2 `billing_addon_prices`

Nova tabela:

- `id`;
- `addon_code`, inicialmente `sdr_seat`;
- `version`;
- `stripe_product_id`;
- `stripe_price_id`;
- `livemode`;
- `currency`;
- `unit_amount`;
- `billing_interval`, `interval_count`;
- `active`, `effective_from`, `retired_at`;
- unique por Price/ambiente e por versão/intervalo/ambiente.

### 5.3 `tenant_subscription_items`

Persistir cada item do Stripe, porque o código atual assume apenas o primeiro item
da assinatura e isso deixa de ser válido:

- `id`;
- `tenant_subscription_id`;
- `stripe_subscription_item_id`;
- `stripe_price_id`;
- `item_kind` (`base_plan`, `sdr_seat`);
- `plan_version_id` nullable;
- `addon_price_id` nullable;
- `quantity`;
- `provider_updated_at`, `created_at`, `updated_at`;
- unique `(stripe_subscription_item_id, livemode)`.

Uma constraint garante exatamente um item `base_plan` por assinatura aberta e no
máximo um item `sdr_seat`.

### 5.4 Estender `tenant_entitlements`

Adicionar a projeção efetiva:

- `included_sdrs`;
- `purchased_extra_sdrs`;
- `max_sdrs` continua sendo o total efetivo;
- `feature_entitlements JSONB`;
- `limit_entitlements JSONB`;
- `last_active_feature_entitlements JSONB` para leitura após perda/downgrade;
- `catalog_version`;
- `subscription_quantity_version` para controle de concorrência.

Regra:

```text
effective_max_sdrs = min(
  plan.max_sdrs,
  plan.included_sdrs + paid_sdr_seat_quantity
)
```

O snapshot tambÃ©m expÃµe `planMaxSdrs` como teto comercial do plano. Ele Ã©
usado somente para validar a compra de novos seats; `maxSdrs` continua sendo a
capacidade efetiva jÃ¡ paga para autorizaÃ§Ã£o de membros e convites.

### 5.5 Alterações pendentes

Criar `tenant_billing_changes` para upgrade/downgrade/redução:

- tipo, status, plano/quantidade atual e desejada;
- IDs Stripe relevantes;
- `effective_at`;
- autor e idempotency key;
- motivo de falha/cancelamento;
- timestamps.

Estados: `previewed`, `pending_payment`, `scheduled`, `applied`, `failed`,
`canceled`.

### 5.6 Overrides e kill switches

Criar `tenant_entitlement_overrides`:

- tenant e chave de recurso/limite;
- operação `grant`, `deny` ou `replace_limit`;
- valor JSON;
- motivo obrigatório;
- autor;
- início e expiração obrigatória para `grant`;
- revogação e auditoria.

Separar:

- **entitlement comercial:** vem do plano e pode conceder recurso;
- **kill switch operacional:** pode desabilitar por incidente, nunca conceder;
- **override de suporte:** pode conceder temporariamente, sempre expira.

## 6. Motor automático de entitlements

### 6.1 Serviço central

Criar `PlanEntitlementService` ou evoluir o `EntitlementService` atual para produzir
um único snapshot:

```ts
{
  accessMode: 'full' | 'read_only' | 'blocked',
  planCode: 'starter' | 'growth' | 'pro' | 'enterprise' | null,
  features: Record<string, 'none' | 'read_only' | 'basic' | 'full'>,
  limits: {
    includedSdrs: number,
    purchasedExtraSdrs: number,
    maxSdrs: number,
    maxLeads: number,
    retentionDays: number
  },
  source: 'stripe' | 'manual_grant' | 'none',
  version: number
}
```

Ordem de cálculo:

1. bloquear tenant administrativamente inativo;
2. resolver assinatura e Price do plano-base;
3. resolver quantidade paga de seats;
4. carregar versão imutável do catálogo;
5. aplicar situação financeira e `access_until`;
6. aplicar kill switches;
7. aplicar override temporário válido;
8. persistir snapshot versionado;
9. invalidar Redis e publicar mudança;
10. pausar geração de chamadas se perdeu permissão operacional.

### 6.2 Ativação automática de recursos

O webhook que confirma uma assinatura ou mudança paga deve:

1. persistir todos os subscription items;
2. identificar o plano por Price ID local;
3. ler `feature_entitlements` da versão do plano;
4. calcular limites e seats;
5. atualizar `tenant_entitlements` na mesma transação;
6. invalidar cache/publicar evento;
7. atualizar a interface sem ação do super admin.

O super admin deixa de marcar flags comerciais uma a uma.

### 6.3 Evolução do `FeatureFlagsService`

O serviço atual mistura rollout técnico e concessão comercial. Separar os papéis:

- `ProductEntitlementsService`: o que o plano comprou;
- `OperationalFlagsService`: rollout/kill switch controlado pela equipe;
- `EffectiveFeatureService`: interseção dos dois mais overrides temporários.

Regra efetiva:

```text
feature_access = commercial_entitlement
                 AND rollout_enabled
                 AND NOT operational_kill_switch
```

Um rollout desligado pode impedir uma feature ainda não pronta. Um super admin não
pode ligar uma feature não comprada usando o painel comum. Concessão excepcional
usa o fluxo de override com motivo e expiração.

### 6.4 Leitura após perda de plano

- assinatura inativa: nenhuma mutação e nenhuma nova chamada;
- módulos que o tenant já utilizava continuam consultáveis em modo histórico;
- recurso nunca contratado permanece indisponível;
- dados acima do limite após downgrade não são apagados;
- `last_active_feature_entitlements` determina o que pode ser visto;
- reativação restaura o plano sem reativar discador automaticamente.

## 7. Backend e APIs

### 7.1 Catálogo e comparação

- `GET /api/tenants/:tenantId/billing/catalog`;
- retornar planos, recursos, seats incluídos, teto e Prices já formatados;
- nunca retornar segredos;
- mostrar plano recomendado quando o uso atual não cabe no Starter.

### 7.2 Checkout

Evoluir `POST .../billing/checkout-session` para receber:

```json
{
  "planCode": "growth",
  "interval": "month",
  "totalSdrSeats": 20
}
```

O Stripe client passa a aceitar vários line items. O backend resolve valores e
Prices pelo catálogo e rejeita intervalos ou quantidades inconsistentes.

### 7.3 Gestão de seats

- `POST .../billing/seats/preview`;
- `POST .../billing/seats/change`;
- `DELETE .../billing/changes/:changeId` para cancelar redução agendada;
- retorno inclui preço atual, pró-rata, próximo total, data efetiva e impacto no
  limite;
- erros padronizados: `seat_quantity_below_usage`, `seat_cap_exceeded`,
  `payment_confirmation_required`, `billing_change_in_progress`.

### 7.4 Mudança de plano

- `POST .../billing/plan-change/preview`;
- `POST .../billing/plan-change`;
- validação de SDRs, convites, números, leads e feature usage;
- upgrade imediato condicionado a pagamento;
- downgrade agendado;
- apenas uma alteração pendente por tenant.

### 7.5 Capacidade de SDR

Manter o lock transacional atual, mas trocar a origem do limite:

- não usar `tenants.max_sdrs` como fonte comercial;
- usar `tenant_entitlements.max_sdrs` efetivo;
- contar memberships SDR ativos e convites pendentes;
- convite, reenvio expirado, aceite, reativação e troca de papel passam pela mesma
  função;
- seat pago ainda não confirmado não aumenta capacidade;
- redução pendente não diminui capacidade antes da data efetiva.

### 7.6 Outros limites

Criar serviços equivalentes para:

- `NumberCapacityService`;
- `LeadCapacityService`;
- `ConcurrentCallCapacityService`;
- política de retenção.

Todos leem o snapshot do entitlement e usam resposta 409 com uso, limite e ação
recomendada.

## 8. Webhooks e reconciliação

Além dos eventos já usados, considerar:

- `checkout.session.completed`;
- `customer.subscription.created`;
- `customer.subscription.updated`;
- `customer.subscription.deleted`;
- `customer.subscription.pending_update_applied`;
- `customer.subscription.pending_update_expired`;
- `invoice.paid`;
- `invoice.payment_failed`;
- `invoice.payment_action_required`;
- `invoice.finalization_failed`.

O processador deve sempre recuperar/classificar todos os items da assinatura. Não
usar `items.data[0]` como plano-base.

Regras de convergência:

- Price desconhecido vai para dead-letter;
- duas bases ou dois add-ons de seat invalidam a projeção;
- evento fora de ordem não reduz versão mais nova;
- `invoice.paid` é necessário para conceder seats adicionais cobrados;
- reconciliação compara plano, items, quantidades, pending updates e entitlement;
- divergência nunca é corrigida confiando em valores vindos do frontend.

## 9. Frontend

### 9.1 Página de planos

- comparação clara dos quatro planos;
- preço mensal/anual;
- matriz de recursos sem jargão interno;
- indicação de “até 2/5/10 SDRs” por plano e do adicional de R$ 19,90 quando houver capacidade extra no catálogo;
- simulador de total antes do Checkout;
- recomendação automática do plano mais econômico para a quantidade escolhida;
- aviso de que capacidade de chamadas não é igual ao número de SDRs.

### 9.2 Gestão de seats

- mostrar `ativos + convites / contratados`;
- stepper para total desejado;
- prévia de pró-rata e próximo pagamento;
- bloquear redução incompatível e listar ações necessárias;
- mostrar redução agendada e opção de cancelar;
- após pagamento, aguardar webhook e mostrar “confirmando pagamento”.

### 9.3 Recursos automáticos

- navegação usa `effectiveFeatures` retornado pela API;
- recurso fora do plano exibe comparação/CTA de upgrade;
- recurso em rollout desligado exibe indisponibilidade operacional, não cobrança;
- recurso histórico em `read_only` mostra dados, mas desabilita ações;
- frontend não usa feature flags locais como fonte de autorização.

### 9.4 Super admin

- mostrar entitlement comercial e Price/assinatura que o originou;
- retirar toggles comerciais comuns;
- manter kill switches separados;
- override temporário exige motivo e expiração;
- visualizar divergência entre Stripe, catálogo e snapshot efetivo.

## 10. Auditoria e observabilidade

Eventos mínimos:

- `billing.plan_activated`;
- `billing.plan_change_requested/applied/failed`;
- `billing.seat_change_requested/applied/failed`;
- `billing.feature_entitlements_changed`;
- `billing.limit_entitlements_changed`;
- `billing.entitlement_override_created/revoked/expired`;
- `billing.capacity_denied` com tipo do limite;
- `billing.catalog_price_unknown`;
- `billing.subscription_items_invalid`.

Métricas:

- MRR por plano e receita de seats;
- seats incluídos, comprados e realmente usados;
- expansão/contração de seats;
- conversão Starter → Growth e Growth → Pro;
- organizações acima do próximo limite após downgrade agendado;
- tempo entre pagamento e entitlement ativo;
- divergências de quantidade entre Stripe e banco;
- uso de override manual;
- margem estimada e tickets de suporte por plano.

## 11. Segurança e consistência financeira

- Price IDs e valores vêm apenas do servidor;
- chave Stripe com menor privilégio possível;
- secrets separados entre teste e produção;
- raw-body e assinatura obrigatórios no webhook;
- idempotency key em Checkout, troca de plano e seats;
- lock por tenant em qualquer mudança de capacidade;
- nunca registrar segredo, cartão ou payload completo de cliente;
- mudanças financeiras exigem auditoria de ator e origem;
- Customer Portal não pode contornar validações de downgrade/quantidade;
- nenhum evento de frontend concede entitlement;
- `STRIPE_LIVEMODE` precisa coincidir com catálogo, chave e webhook.

## 12. Migração das flags manuais

### 12.1 Inventário

Para cada tenant, registrar:

- flags atuais;
- recursos realmente utilizados;
- número de SDRs ativos e convites;
- números, leads e retenção existente;
- contrato/comercial vigente;
- plano proposto e exceções necessárias.

### 12.2 Backfill

- clientes pagantes recebem plano/versionamento compatível;
- cliente sem Stripe recebe manual grant temporário com expiração;
- flags atuais que excedem o plano viram override temporário auditado;
- flags desligadas por incidente viram kill switch, não ausência de compra;
- nenhum tenant é cortado apenas pela migration.

### 12.3 Shadow mode

Por pelo menos sete dias:

- calcular entitlements automáticos sem alterar a resposta vigente;
- comparar automático versus manual;
- classificar cada divergência;
- corrigir catálogo/backfill;
- avançar somente com zero divergência inexplicada.

## 13. Testes

### 13.1 Unidade

- matriz de plano → recursos/limites;
- cálculo de seats incluídos/adicionais/teto;
- classificação de subscription items independente de ordem;
- Price mensal não combina com seat anual;
- override, kill switch e expiração;
- preservação de `last_active_feature_entitlements`;
- recomendação do plano mais econômico.

### 13.2 Integração

- Checkout sem adicional e com quantidade adicional;
- pagamento ativa recursos sem admin;
- falha de pagamento não concede recursos/seats;
- adição simultânea de seat e convite nunca excede limite;
- redução abaixo de usados + reservados retorna 409;
- upgrade troca features e recalcula extras;
- downgrade agenda e preserva dados;
- webhook duplicado/fora de ordem converge;
- Price desconhecido vai para dead-letter;
- isolamento entre tenants e entre test/live.

### 13.3 Frontend/E2E

- simulador calcula corretamente todos os planos;
- CTA de upgrade aparece em feature não contratada;
- recurso liga automaticamente após `invoice.paid`;
- seat novo só permite convite depois da confirmação;
- redução pendente e bloqueios são compreensíveis;
- organização inadimplente mantém leitura histórica;
- reativação não inicia discador automaticamente.

### 13.4 Stripe sandbox

- contratação Starter com 2 seats;
- bloqueio ao tentar ultrapassar o teto de 2 seats;
- upgrade Starter → Growth com 5 seats;
- redução agendada;
- upgrade Starter → Growth;
- downgrade Pro → Growth com uso excedente;
- renovação, `past_due`, recuperação e cancelamento;
- Test Clock atravessando duas renovações.

## 14. Rollout em fases

### Fase 0 — aprovação comercial

- aprovar preços, anual, features e tetos;
- confirmar setup/onboarding;
- definir tratamento fiscal e nota;
- decidir grandfathering do seat a R$ 19,90.

### Fase 1 — catálogo e migration

- criar migration nova;
- inserir versões `draft`;
- implementar validação do JSON de entitlements;
- não publicar Prices nem aplicar enforcement novo.

### Fase 2 — motor automático

- separar entitlement comercial, rollout e kill switch;
- projetar features/limites no `tenant_entitlements`;
- adaptar guards e serviços de capacidade;
- manter comportamento atual em shadow.

### Fase 3 — Stripe multi-item

- criar Products/Prices em test mode;
- adaptar Checkout e sync de subscription items;
- implementar seat preview/change e pending changes;
- configurar webhook/reconciliação.

### Fase 4 — UI

- página de comparação e simulador;
- gestão de seats e mudanças pendentes;
- recursos automáticos e CTAs de upgrade;
- painel separado de override/kill switch.

### Fase 5 — backfill e piloto

- mapear tenants atuais;
- sete dias de shadow;
- sandbox completo;
- piloto com uma organização interna e duas acompanhadas;
- validar cobrança, suporte e capacidade real.

### Fase 6 — produção

- criar Prices live imutáveis;
- cadastrar IDs no catálogo live;
- configurar secrets e webhook;
- ativar enforcement por tenant e depois global;
- monitorar pagamento → entitlement, capacidade e dead letters.

## 15. Rollback

- desligar resolução comercial automática via flag de rollout;
- retornar temporariamente ao snapshot/manual grant anterior;
- continuar ingerindo webhooks e reconciliando;
- não apagar Products, Prices, Customers ou assinaturas;
- não reverter migration destrutivamente;
- não reduzir seats nem recursos durante rollback;
- qualquer concessão emergencial precisa de motivo e expiração.

Antes de qualquer build, deploy, restart ou mudança em produção, seguir
integralmente `docs/deploy-runbook.md`. Rust/Waxum nunca deve ser compilado na VPS.

## 16. Critérios de aceite

- [x] Starter custa R$ 89,90/mês e permite até 2 SDRs.
- [x] Seat adicional custa R$ 19,90/mês e só existe com plano-base.
- [x] Assinatura representa base e seats na mesma fatura.
- [x] Pagamento confirmado ativa automaticamente recursos e limites.
- [x] Super admin não precisa ligar flags comerciais manualmente.
- [x] Admin mantém kill switch e override temporário auditado.
- [x] Limite de SDR usa seats pagos, membros ativos e convites pendentes.
- [x] Seat não pago ou update pendente não aumenta capacidade.
- [x] Redução nunca desativa pessoas ou apaga dados automaticamente.
- [x] Upgrade e downgrade respeitam limites e data efetiva.
- [x] Perda de plano preserva leitura histórica e bloqueia mutações/chamadas.
- [x] Subscription items são processados sem depender da ordem.
- [ ] Stripe, banco, cache e frontend convergem por webhook/reconciliação.
- [ ] Testes unitários, integração, E2E e sandbox estão verdes.
- [ ] Rollout shadow não apresenta divergência inexplicada.

## 17. Ordem recomendada do backlog

1. Aprovar a tabela comercial deste documento.
2. Criar migration de catálogo, add-ons, subscription items e overrides.
3. Implementar schema/validação de entitlements versionados.
4. Separar feature comercial de rollout e kill switch.
5. Evoluir projeção de assinatura para múltiplos items.
6. Adaptar Checkout para plano + quantidade de seats.
7. Implementar prévia/alteração de seats e mudanças pendentes.
8. Aplicar limites de leads e de retenção do histórico de métricas; capacidade de chamadas será governada por infraestrutura, saúde das linhas e fair use, não por um limite fixo do plano.
9. Implementar UI de comparação, simulador e gestão de seats.
10. Migrar flags manuais para plano/override.
11. Rodar shadow, sandbox e Test Clocks.
12. Criar catálogo live, pilotar e ativar produção progressivamente.

## 18. Referências

- [Stripe: quantidades e cobrança por seat](https://docs.stripe.com/billing/subscriptions/quantities)
- [Stripe: desenho de integrações de assinatura](https://docs.stripe.com/billing/subscriptions/design-an-integration)
- [Stripe: modelo de preço por seat](https://docs.stripe.com/subscriptions/pricing-models/per-seat-pricing)
- [Stripe: Entitlements](https://docs.stripe.com/billing/entitlements)
- [Discador Online: referência pública por operador](https://discador.online/precos/)
- [Salesforce Sales Engagement: referência internacional](https://www.salesforce.com/sales/engagement-platform/pricing/)
- `docs/relatorio-custos-pricing.md`
- `docs/plano-integracao-stripe.md`
