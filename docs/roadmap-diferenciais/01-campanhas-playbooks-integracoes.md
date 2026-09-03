# Plano 01 — Campanhas, playbooks e integrações

## Resultado desejado

Permitir que um líder transforme uma origem de leads em uma operação repetível:
destino, prioridade, agenda, cadência, equipe, números, resultados esperados e
integrações ficam reunidos em uma campanha versionada.

## Problema atual

O ZapLiga já possui pastas, ingestão por API/webhook, configurações do discador,
agenda, métricas e callbacks. Entretanto, essas configurações vivem em áreas
separadas e o líder precisa reconstruir mentalmente qual conjunto forma uma ação
comercial. A pasta organiza leads, mas não representa toda a operação.

## Escopo do MVP

- Criar, editar, duplicar, iniciar, pausar, encerrar e arquivar campanhas.
- Vincular uma campanha a uma pasta principal.
- Definir equipe elegível, linhas elegíveis, agenda e regras de tentativas.
- Definir catálogo de resultados e meta principal da campanha.
- Associar integrações de entrada à campanha.
- Preservar a versão de configuração usada em cada chamada.
- Oferecer playbooks de criação rápida como modelos copiáveis.

Não entra no MVP: editor visual de automações, mensagens automáticas, CRM completo,
marketplace público de templates ou alterações automáticas por IA.

## Reaproveitamento do projeto

- `lead_folders` continua sendo o contêiner operacional dos leads.
- `lead_integrations` continua responsável por autenticação, idempotência e entrada.
- `dialer_settings` fornece defaults globais e limites máximos de segurança.
- `dialer_schedules` fornece o modelo de janelas e exceções.
- `metric_goals` continua registrando metas, agora com escopo de campanha.
- `feature-flags` controla rollout por empresa.

## Modelo de domínio

### Migration proposta: `042_campaigns_and_playbooks.sql`

Criar `campaigns`:

- `id`, `tenant_id`, `name`, `description`;
- `status`: `draft`, `ready`, `running`, `paused`, `completed`, `archived`;
- `folder_id`;
- `primary_goal_metric` e `primary_goal_target` opcionais;
- `current_version`;
- `started_at`, `paused_at`, `completed_at`, `created_by`, timestamps.

Criar `campaign_versions`:

- identificação da campanha e número da versão;
- snapshot JSON validado das regras comerciais;
- agenda, cadência, estratégia de fila e critérios de elegibilidade;
- IDs de SDRs e números permitidos;
- autor e justificativa da alteração;
- hash do conteúdo para rastreabilidade.

Criar relações:

- `campaign_sdrs`;
- `campaign_numbers`;
- `campaign_playbooks` para modelos reutilizáveis por tenant;
- `campaign_id` e `campaign_version` em `calls`;
- `campaign_id` em `lead_integrations` e, quando aplicável, em `leads`.

Todas as chaves estrangeiras de domínio devem validar também `tenant_id`.

## Regras de precedência

1. Compliance, supressão, horário permitido e proteção da linha são invioláveis.
2. Limites globais da empresa funcionam como teto.
3. Regras da campanha refinam o comportamento abaixo desse teto.
4. Defaults globais são usados quando a campanha não sobrescreve um campo.
5. Cada chamada grava a versão efetiva para permitir auditoria histórica.

Alterar uma campanha em execução cria nova versão. Chamadas já reservadas mantêm a
versão anterior; novas reservas usam a versão publicada mais recente.

## Backend

Criar `apps/api/src/modules/campaigns/` com:

- `campaigns.controller.ts`;
- `campaigns.service.ts`;
- `campaigns.repository.ts`;
- DTOs de criação, edição, publicação, mudança de estado e duplicação;
- validador puro de regras e testes unitários.

Endpoints principais:

```text
GET    /api/tenants/:tenantId/campaigns
POST   /api/tenants/:tenantId/campaigns
GET    /api/tenants/:tenantId/campaigns/:campaignId
PATCH  /api/tenants/:tenantId/campaigns/:campaignId
POST   /api/tenants/:tenantId/campaigns/:campaignId/publish
POST   /api/tenants/:tenantId/campaigns/:campaignId/start
POST   /api/tenants/:tenantId/campaigns/:campaignId/pause
POST   /api/tenants/:tenantId/campaigns/:campaignId/complete
POST   /api/tenants/:tenantId/campaigns/:campaignId/duplicate
GET    /api/tenants/:tenantId/campaign-playbooks
POST   /api/tenants/:tenantId/campaign-playbooks
```

O `DialerService` deve resolver configurações efetivas por campanha antes de
selecionar leads. A resolução deve ser função testável e retornar também a origem de
cada valor: `global_default`, `campaign_override` ou `safety_cap`.

## Frontend

Criar `apps/web/src/features/campaigns/` e adicionar `Campanhas` ao grupo Operação.

Fluxo de criação:

1. objetivo e nome;
2. origem e pasta;
3. equipe e números;
4. agenda e cadência;
5. resultados e meta;
6. revisão e publicação.

A tela de detalhe deve mostrar estado, volume, conversão, versão vigente, origem dos
leads, regras aplicadas e eventos recentes. Configurações avançadas permanecem
recolhidas por padrão.

## Integrações e lock-in saudável

- Toda integração pode apontar para campanha e pasta.
- O evento de ingestão preserva `external_id`, origem e versão de mapeamento.
- Alterar destino não move silenciosamente leads já recebidos.
- Fornecer exemplos de payload para RD Station, HubSpot, Pipedrive e formulários,
  sem acoplar o domínio a um fornecedor.
- Preparar eventos de saída: lead recebido, chamada atendida, resultado registrado,
  etapa alterada e callback criado.
- Outbound webhooks devem ter assinatura, idempotência, retry e dead-letter.

## Auditoria e observabilidade

Eventos mínimos:

```text
campaign.created
campaign.version_published
campaign.started
campaign.paused
campaign.completed
campaign.archived
campaign.playbook_created
campaign.integration_attached
campaign.integration_detached
```

Métricas técnicas: campanhas por estado, falhas de publicação, latência de resolução
de regras, leads ingeridos por campanha e chamadas sem versão associada.

## Fases

### Fase 1 — domínio e leitura

- Migration, módulo, listagem e detalhe.
- Backfill opcional de uma campanha legada por tenant, sem alterar a fila.
- Feature flag `campaigns` desligada por padrão.

### Fase 2 — criação e versionamento

- Wizard, validação, publicação e auditoria.
- Comparação visual entre versões.

### Fase 3 — execução

- Resolver agenda, SDRs, números e cadência por campanha.
- Iniciar em modo de compatibilidade com uma campanha ativa por pasta.

### Fase 4 — integrações e playbooks

- Associar entrada e emitir eventos de saída.
- Duplicar campanha e salvar como playbook.

## Critérios de aceite

- [ ] Uma campanha publicada contém configuração suficiente para iniciar a operação.
- [ ] Uma chamada registra campanha e versão efetivamente utilizadas.
- [ ] Nenhuma regra de campanha ultrapassa limites globais de segurança.
- [ ] Dois tenants não conseguem consultar ou vincular recursos entre si.
- [ ] Editar campanha em execução não modifica chamadas já reservadas.
- [ ] Eventos de ingestão duplicados não criam leads duplicados.
- [ ] O líder consegue duplicar uma campanha e iniciá-la após revisar as diferenças.
- [ ] Testes unitários, integração, multitenant e E2E cobrem o ciclo completo.

## Métricas de produto

- tempo entre criar empresa e iniciar primeira campanha;
- percentual de campanhas iniciadas sem intervenção do suporte;
- campanhas duplicadas a partir de playbook;
- leads recebidos automaticamente por campanha;
- chamadas e resultados sem atribuição de campanha;
- taxa de erro de configuração antes e depois do wizard.

## Riscos

- Configurações globais e por campanha podem se contradizer: tornar precedência
  visível e centralizar a resolução no backend.
- Múltiplas campanhas podem competir por capacidade: o motor de decisão deverá
  aplicar cotas e fairness.
- Uma campanha pode virar um CRM disfarçado: limitar o domínio à execução outbound.
