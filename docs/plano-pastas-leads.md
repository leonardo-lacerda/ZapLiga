# Plano técnico e funcional: pastas de leads

Este documento descreve a transformação da aba **Leads** em um gerenciador de listas
independentes ("pastas"), com importação, ativação/pausa por pasta, rodízio entre
pastas ativas no discador e métricas próprias por pasta. Nenhum arquivo de código foi
alterado — este documento é a referência para a implementação, ancorada na estrutura
atual do repositório.

## 0. Estado atual (referência)

- Schema: migrations SQL puras em `apps/api/src/database/migrations/*.sql`, aplicadas
  em ordem por `DatabaseService.migrate()` ([database.service.ts](apps/api/src/database/database.service.ts)).
  A última é `009_global_whatsapp_number_pool.sql` → a nova migration será
  `010_lead_folders.sql`.
- Tabelas relevantes hoje: `leads`, `calls`, `dialer_settings`, `whatsapp_numbers`,
  `sdrs`, `sdr_pauses`, todas com `tenant_id` (multi-tenant, ver `003_add_tenant_to_domain.sql`
  e `004_constraints_and_indexes.sql`).
- API de leads: [leads.controller.ts](apps/api/src/modules/leads/leads.controller.ts)
  (`/api/leads` e `/api/tenants/:tenantId/leads`, padrão de rota dupla usado em todo o
  projeto), parsing de CSV em [lead-import.ts](apps/api/src/modules/leads/lead-import.ts).
- Discador: [dialer.service.ts](apps/api/src/modules/dialer/dialer.service.ts) (loop
  `tick()` a cada 1s via `setInterval`, reserva atômica em Redis via
  `RedisService.reserve` em [redis.service.ts](apps/api/src/infrastructure/redis/redis.service.ts),
  regras puras em [dialer.rules.ts](apps/api/src/modules/dialer/dialer.rules.ts)).
- Frontend: estado de leads centralizado em [App.tsx](apps/web/src/app/App.tsx)
  (`leads`, `leadForm`, `createLead`, `importCsv`, `clearLeads`, `manualCall`,
  `resetLead`, `removeLead`), renderizado por
  [LeadsPage.tsx](apps/web/src/features/leads/LeadsPage.tsx). Tipagem hoje é
  `AnyRow = Record<string, any>` ([types/index.ts](apps/web/src/types/index.ts)).
- Auditoria: `AuditService.record()` em [audit.service.ts](apps/api/src/modules/audit/audit.service.ts),
  já usada em todas as mutações de leads/discador.

## 1. Regras de negócio

### Pastas (`lead_folders`)

Cada pasta pertence a um tenant e tem:

- nome único dentro da empresa;
- status `is_active` (ativa/inativa);
- quantidade total de leads e quantidade prontos para discagem (derivadas, não
  armazenadas — ver seção 5);
- `created_at` / `updated_at` / `deactivated_at`;
- histórico de importações e alterações via `audit_logs` (já existente, reaproveitado).

### Ativação simultânea

- Mais de uma pasta pode estar ativa ao mesmo tempo.
- Apenas leads de pastas com `is_active = true` entram na fila automática e podem ser
  discados manualmente.
- Desativar uma pasta não exclui leads nem encerra chamadas em andamento (`reserved`,
  `dialing`, `media_active` continuam até `finishCall`).
- Após desativação, nenhum novo lead da pasta é reservado — a query de seleção do
  discador exige `lead_folders.is_active = true` no momento da reserva (dupla checagem:
  na leitura da fila e dentro da transação de reserva, ver seção 4).
- Se nenhuma pasta estiver ativa, `/api/dialer/status` retorna `next_action = 'Nenhuma pasta ativa'`.
- O limite global de chamadas simultâneas continua por tenant (`dialer_settings.global_max_concurrent_calls`,
  aplicado via Redis), não por pasta.

### Rodízio entre pastas ativas

- Dentro de cada pasta, mantém-se a ordem atual: `next_eligible_at ASC, created_at ASC`
  (mesma lógica de `leadIsEligible` em [dialer.rules.ts](apps/api/src/modules/dialer/dialer.rules.ts)).
- Entre pastas ativas, o discador intercala: uma pasta grande não consome toda a
  capacidade de um tick enquanto outras pastas ativas tiverem leads elegíveis.
- Quando uma pasta fica sem leads elegíveis, o rodízio segue normalmente com as demais.
- O rodízio respeita os limites já existentes (SDRs disponíveis, números conectados
  fora de cooldown, `global_max_concurrent_calls` via `RedisService.reserve`).

Exemplo de intercalação (3 pastas ativas, A com mais leads que B e C):

```
Pasta A → lead 1
Pasta B → lead 1
Pasta C → lead 1
Pasta A → lead 2
Pasta B → lead 2
Pasta A → lead 3
```

### Duplicidade de telefone

- Mantém-se a regra atual: telefone único por tenant (`leads_tenant_phone_unique` em
  `004_constraints_and_indexes.sql`). Com pastas, a unicidade continua por
  `(tenant_id, phone)` — **não** por `(tenant_id, folder_id, phone)` — ou seja, um
  telefone só pode existir em uma pasta por empresa.
- Importar um telefone já existente não o move silenciamente para a nova pasta; o
  resultado da importação relata quantos registros foram importados, inválidos,
  duplicados (já em outra pasta) e atualizados (já na mesma pasta, nome atualizado).
- Empresas diferentes podem repetir o mesmo telefone (isolamento por `tenant_id`
  preservado).

## 2. Alterações no banco de dados

Nova migration `apps/api/src/database/migrations/010_lead_folders.sql`, idempotente
como as demais (usa `IF NOT EXISTS` / `DO $$ ... $$`).

### 2.1 Tabela `lead_folders`

```sql
CREATE TABLE IF NOT EXISTS lead_folders (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deactivated_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS lead_folders_tenant_name_unique
  ON lead_folders (tenant_id, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS lead_folders_tenant_id_unique
  ON lead_folders (tenant_id, id);
```

`(tenant_id, id)` como chave composta única segue o mesmo padrão usado por
`leads_tenant_id_unique`, `sdrs_tenant_id_unique` etc., necessário para as FKs
compostas `(tenant_id, folder_id)` abaixo.

### 2.2 `folder_id` em `leads` e `calls`

```sql
ALTER TABLE leads ADD COLUMN IF NOT EXISTS folder_id TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS folder_id TEXT;
```

`calls.folder_id` é uma **cópia** do vínculo do lead no momento da reserva (não um
FK dinâmico via join) — preserva métricas históricas caso o lead seja movido de pasta
depois. Isso espelha o que já acontece com `calls.pipeline_stage`, que também é uma
cópia pontual do estado do lead.

### 2.3 Backfill (dentro da mesma migration, por tenant)

```sql
DO $$
DECLARE t RECORD; default_folder_id TEXT;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    default_folder_id := 'folder-default-' || t.id;
    INSERT INTO lead_folders (id, tenant_id, name, is_active, sort_order)
    VALUES (default_folder_id, t.id, 'Lista principal', true, 0)
    ON CONFLICT (tenant_id, id) DO NOTHING;

    UPDATE leads SET folder_id = default_folder_id
      WHERE tenant_id = t.id AND folder_id IS NULL;

    UPDATE calls c SET folder_id = l.folder_id
      FROM leads l
      WHERE c.tenant_id = t.id AND c.lead_id = l.id AND c.folder_id IS NULL;

    -- chamadas cujo lead foi excluído: caem na pasta padrão do tenant.
    UPDATE calls SET folder_id = default_folder_id
      WHERE tenant_id = t.id AND folder_id IS NULL;
  END LOOP;
END $$;
```

### 2.4 Constraints finais (obrigatoriedade + FKs)

```sql
ALTER TABLE leads ALTER COLUMN folder_id SET NOT NULL;
ALTER TABLE calls ALTER COLUMN folder_id SET NOT NULL;

ALTER TABLE leads
  ADD CONSTRAINT leads_tenant_folder_fk
  FOREIGN KEY (tenant_id, folder_id) REFERENCES lead_folders (tenant_id, id);

ALTER TABLE calls
  ADD CONSTRAINT calls_tenant_folder_fk
  FOREIGN KEY (tenant_id, folder_id) REFERENCES lead_folders (tenant_id, id);
```

A unicidade de telefone por empresa (`leads_tenant_phone_unique`) não muda — permanece
`(tenant_id, phone)`, reforçando a regra de "um telefone, uma pasta" sem precisar de
lógica extra na aplicação além do `ON CONFLICT` já usado hoje em
`leads.controller.ts`.

### 2.5 Índices

```sql
CREATE INDEX IF NOT EXISTS leads_tenant_folder_idx
  ON leads (tenant_id, folder_id);

CREATE INDEX IF NOT EXISTS leads_tenant_folder_queue_idx
  ON leads (tenant_id, folder_id, status, next_eligible_at)
  WHERE do_not_call = false;

CREATE INDEX IF NOT EXISTS leads_tenant_folder_created_idx
  ON leads (tenant_id, folder_id, created_at);

CREATE INDEX IF NOT EXISTS calls_tenant_folder_created_idx
  ON calls (tenant_id, folder_id, created_at);
```

`leads_tenant_folder_queue_idx` substitui, na prática, o papel de
`leads_tenant_queue_idx` (`004_constraints_and_indexes.sql`) para as queries do
discador, que passam a filtrar por pasta ativa — o índice antigo pode ser mantido
(ainda serve `GET /api/leads` sem filtro de pasta) ou removido se o `EXPLAIN` mostrar
redundância; decisão de implementação, não bloqueante para o plano.

Não é necessária uma tabela de métricas agregadas agora — os indicadores são
calculados sob demanda a partir de `leads` e `calls` (seção 5). Uma tabela de
agregação (`lead_folder_metrics_daily` ou similar) fica como evolução futura se o
volume exigir.

## 3. Novos endpoints da API

Novo módulo `apps/api/src/modules/lead-folders/` seguindo a estrutura de
`modules/leads` (controller + dto + spec), registrado no `AppModule` ao lado de
`LeadsModule`.

### 3.1 CRUD de pastas

```
GET    /api/lead-folders                 (+ /api/tenants/:tenantId/lead-folders)
POST   /api/lead-folders
PATCH  /api/lead-folders/:id
DELETE /api/lead-folders/:id
```

- `@UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard)` + `@Roles('leader', 'super_admin')`,
  igual a `LeadsController` e `DialerController`.
- `POST`: cria com `is_active` default `true`; valida nome único (case-insensitive)
  por tenant via `ON CONFLICT` na constraint `lead_folders_tenant_name_unique` →
  `ConflictException`.
- `PATCH`: renomear, `is_active` (ativar/desativar), `sort_order`. Ao desativar, seta
  `deactivated_at = now()`; ao reativar, `deactivated_at = NULL`.
- `DELETE`: só funciona para pastas vazias (`SELECT count(*) FROM leads WHERE folder_id = $1`
  → 0). Pastas com leads devem ser **arquivadas** (`is_active = false` — reaproveita o
  campo, não precisa de um novo status) ou ter os leads movidos antes via endpoint de
  leads-por-pasta.
- A pasta padrão (`Lista principal`, id `folder-default-<tenantId>`) pode ser
  renomeada e desativada como qualquer outra, mas não pode ser excluída (mesma regra
  de "só pastas vazias" já cobre isso na prática, já que ela nasce com todos os leads
  legados).

### 3.2 Leads por pasta

```
GET    /api/lead-folders/:id/leads
POST   /api/lead-folders/:id/leads       (cadastro manual com destino explícito)
POST   /api/lead-folders/:id/import      (multipart, mesmo parsing de lead-import.ts)
DELETE /api/lead-folders/:id/leads       (limpar apenas esta pasta)
```

- Reaproveita `parseLeadCsvRow` de [lead-import.ts](apps/api/src/modules/leads/lead-import.ts)
  sem alterações — o parsing de CSV é agnóstico de pasta.
- A transação de importação (hoje em `LeadsController.import`) passa a receber
  `folderId` e gravar `folder_id` no `INSERT`. A checagem de duplicidade
  (`existingPhones`) continua por `(tenant_id, phone)`; leads cujo telefone já existe
  em **outra** pasta entram no contador `duplicated` (não movidos); leads cujo
  telefone já existe **na mesma pasta** entram em `updated` (nome atualizado, mesmo
  comportamento de hoje via `ON CONFLICT ... DO UPDATE`).
- `DELETE /api/lead-folders/:id/leads` reaproveita a lógica de `LeadsController.clear`,
  mas com `WHERE folder_id = $id` — e mantém a trava de chamadas ativas
  (`status IN ('reserved','dialing','media_active')`) escopada à pasta.

### 3.3 Compatibilidade com `/api/leads`

O endpoint atual continua existindo, com estas mudanças:

- `GET /api/leads` aceita `?folderId=` como filtro adicional (ao lado de `?status=`
  já existente) e retorna `folder_id` mais um resumo (`folder_name`, `folder_is_active`)
  via `LEFT JOIN lead_folders` — evita uma requisição por card na tabela "Todas as
  pastas" (seção 6).
- `POST /api/leads` aceita `folderId` opcional no corpo; se ausente, usa a pasta
  padrão do tenant (`folder-default-<tenantId>`, resolvida por
  `SELECT id FROM lead_folders WHERE tenant_id = $1 AND name = 'Lista principal'`
  ou, mais robusto, armazenando o id da pasta padrão em `tenants` — decisão de
  implementação; a convenção de id determinístico acima já resolve sem coluna extra).
- Nenhum lead pode ser criado sem `folder_id` — reforçado pela constraint `NOT NULL`
  da seção 2.4, não só na aplicação.

### 3.4 Métricas

```
GET /api/lead-folders/:id/metrics?from=YYYY-MM-DD&to=YYYY-MM-DD
```

Ver seção 5 para a definição exata dos campos. `GET /api/lead-folders` retorna também
um resumo por pasta (contagens totais, sem filtro de data) embutido em cada item, para
os cards da lista lateral não dispararem uma requisição cada.

### 3.5 Auditoria

Reaproveita `AuditService.record()` (já injetado em todos os controllers do domínio):

```
lead_folder.created
lead_folder.renamed
lead_folder.activated
lead_folder.deactivated
lead_folder.archived
lead_folder.imported
lead_folder.cleared
```

Mesmo padrão de `leads.controller.ts` (`lead.created_or_updated`, `lead.imported`,
`lead.cleared`, `lead.removed`, `lead.reset`).

## 4. Integração com o discador

`DialerService.tick()` ([dialer.service.ts:313](apps/api/src/modules/dialer/dialer.service.ts))
hoje seleciona leads com uma única query simples (linha 339):

```sql
SELECT * FROM leads
WHERE tenant_id = $1 AND do_not_call = false AND status IN ('queued','retry_wait')
  AND attempts < $2 AND next_eligible_at <= now()
ORDER BY next_eligible_at ASC, created_at ASC LIMIT 25
```

Essa query precisa ser substituída por uma versão com rodízio entre pastas ativas.

### 4.1 Seleção com rodízio (dentro de `tick()`)

```sql
WITH eligible AS (
  SELECT l.*, f.sort_order AS folder_sort_order,
    ROW_NUMBER() OVER (
      PARTITION BY l.folder_id
      ORDER BY l.next_eligible_at ASC, l.created_at ASC
    ) AS rank_in_folder
  FROM leads l
  JOIN lead_folders f ON f.tenant_id = l.tenant_id AND f.id = l.folder_id
  WHERE l.tenant_id = $1 AND l.do_not_call = false
    AND l.status IN ('queued', 'retry_wait') AND l.attempts < $2
    AND l.next_eligible_at <= now() AND f.is_active = true
)
SELECT * FROM eligible
ORDER BY rank_in_folder ASC, folder_sort_order ASC, folder_id ASC
LIMIT 25;
```

Isso intercala pastas: todos os "1º lead elegível de cada pasta" vêm antes de
qualquer "2º lead", igual ao exemplo da seção 1. `FOR UPDATE SKIP LOCKED` deve ser
adicionado à query (ou a uma sub-seleção equivalente) para que dois processos/ticks
concorrentes não escolham o mesmo lead — hoje isso não é necessário porque não há
concorrência entre pastas nem lock de linha; com o `LIMIT 25` fatiando por rodízio,
uma corrida entre `tick()` de instâncias diferentes da API se torna mais visível.
Como o loop de `tick()` já é serializado por tenant via `RedisService.acquireLock`
(linha 316), o `SKIP LOCKED` é uma proteção adicional de defesa em profundidade, não
uma dependência crítica — mas o plano recomenda adicioná-la já na Fase 3 porque a
reserva em si (seção 4.2) é o ponto que realmente precisa ser atômico.

A rotação de qual pasta "começa" a cada tick (para não favorecer sempre a pasta com
`sort_order` menor quando há empate) pode reaproveitar o padrão já presente e não
utilizado em `dialer_settings.number_rotation_cursor` / `sdr_rotation_cursor`
(`000_initial_domain_schema.sql:79-80`): adicionar `folder_rotation_cursor INTEGER
NOT NULL DEFAULT 0` e usar `ORDER BY ((folder_sort_order + $cursor) % folder_count)`
em vez de `folder_sort_order` puro, incrementando o cursor a cada tick. Isso é um
refinamento de justiça de fila (fairness) — não bloqueia a Fase 3, pode entrar depois
do rodízio básico funcionar.

### 4.2 Reserva da chamada

Em `startReservedCall` ([dialer.service.ts:391](apps/api/src/modules/dialer/dialer.service.ts)),
a transação de reserva (`INSERT INTO calls ... UPDATE leads ... UPDATE sdrs ...`,
linhas 395-399) passa a:

1. Revalidar `is_active` da pasta **dentro da transação**, com `SELECT ... FOR UPDATE`
   na linha de `lead_folders`, antes do `INSERT INTO calls`:
   ```sql
   SELECT is_active FROM lead_folders
   WHERE tenant_id = $1 AND id = $2 FOR UPDATE
   ```
   Se `is_active = false`, aborta a reserva (lead permanece elegível, será pulado
   nesse tick — sem side effect, já que nada foi escrito ainda).
2. Gravar `folder_id` no `INSERT INTO calls` (cópia do `leads.folder_id` no momento
   da reserva, conforme seção 2.2).
3. Continuar dentro da mesma transação (`DatabaseService.transaction`) que já
   atualiza `leads` e `sdrs` — nenhuma mudança estrutural na transação, só mais uma
   leitura e uma coluna a mais no insert.

Isso cobre a janela de corrida "pasta desativada entre a leitura da fila (4.1) e a
reserva (4.2)" mencionada nas regras de negócio.

`manualCall()` (linha 166) recebe o mesmo tratamento: a query de leads elegíveis
(linha 181) ganha `JOIN lead_folders ... WHERE f.is_active = true`, e a ligação manual
para um lead de pasta inativa passa a lançar o mesmo erro que hoje é usado para
"lead não elegível" (`Este lead não está elegível para uma chamada manual`), mas com
mensagem específica (`Esta pasta está pausada; ative-a para ligar para este contato`)
— consumida pelo frontend para o tooltip do botão "Ligar agora" (seção 6).

### 4.3 Status geral do discador

`getStatus()` ([dialer.service.ts:201](apps/api/src/modules/dialer/dialer.service.ts))
ganha os campos novos, calculados a partir de `lead_folders` e da mesma
`queueSummary`/`queuePreview` já existentes, apenas com o `JOIN` de pasta ativa:

```ts
active_folder_count      // count(*) FROM lead_folders WHERE tenant_id = $1 AND is_active
active_folder_ids        // array de ids
queued_leads_active_folders  // = queue.total, mas já filtrado por pasta ativa
folder_queue_summary     // [{ folder_id, name, ready, waiting }] por pasta ativa
```

O `next_action` (linha 279-285) ganha um novo primeiro caso, antes de "Fila vazia":

```ts
if (!settings.running) nextAction = 'Discador pausado';
else if (!active_folder_count) nextAction = 'Nenhuma pasta ativa';
else if (!Number(queue.total)) nextAction = 'Fila vazia';
else if (!Number(available.rows[0].count)) nextAction = 'Aguardando SDR disponível';
else if (!connectedNumbers.length) nextAction = 'Aguardando número WhatsApp conectado';
else if (!readyNumbers.length) nextAction = 'Aguardando cooldown dos números';
else if (!Number(queue.ready)) nextAction = 'Aguardando horário da próxima tentativa';
```

O contador "Contatos na fila" da barra lateral em [App.tsx](apps/web/src/app/App.tsx)
(`queuedLeads`, linha 149, hoje lido de `status.lead_counts?.queued`) passa a usar
`status.queued_leads_active_folders` para refletir só pastas ativas.

## 5. Métricas por pasta

`GET /api/lead-folders/:id/metrics?from=&to=` calcula, no período (`calls.created_at
BETWEEN from AND to`, mesmo padrão de filtro por data já usado em `getStatus` com
`interval '24 hours'`):

| Campo | Origem |
|---|---|
| Total de leads | `count(*) FROM leads WHERE folder_id = $1` |
| Leads na fila | `leadIsEligible` (mesma função de [dialer.rules.ts](apps/api/src/modules/dialer/dialer.rules.ts)) aplicada via SQL, igual à `queueSummary` do discador |
| Leads aguardando retry | `status = 'retry_wait'` |
| Leads concluídos | `status = 'completed'` |
| Leads bloqueados / do_not_call | `do_not_call = true` |
| Total de tentativas | `sum(attempts)` |
| Chamadas atendidas | `count(*) FILTER (WHERE connected_at IS NOT NULL)` em `calls` no período |
| Taxa de atendimento | `atendidas / tentadas` (ver fórmula abaixo) |
| Chamadas sem resposta | `outcome/status = 'no_answer'` |
| Chamadas com falha | `status = 'failed'` |
| Chamadas em andamento | `status IN ('reserved','dialing','media_active')` |
| Distribuição por resultado | `GROUP BY call_result` (campo livre, ver nota) |
| Distribuição por etapa do pipeline | `GROUP BY pipeline_stage` |
| Última importação e quantidade | do `audit_logs` filtrado por `entity_type = 'lead_import'` (ou `action = 'lead_folder.imported'`) e `metadata->>'folderId' = $1`, mais recente |

Fórmula fixa, igual à já usada em `getStatus` (linha 293):

```
taxa_de_atendimento = count(calls WHERE connected_at IS NOT NULL) / count(calls tentadas)
```

`call_result` não tem taxonomia padronizada hoje (campo de texto livre gravado em
`finishPause`, [dialer.service.ts:102-119](apps/api/src/modules/dialer/dialer.service.ts)) —
a conversão (quais resultados contam como "venda"/"positivo") **não** é calculada
automaticamente nesta fase; a API retorna a distribuição bruta agrupada por valor de
`call_result`, e a UI mostra como lista, sem tentar somarizar como taxa de conversão.

O filtro de data hoje é estático em `Dashboard.tsx` — passa a enviar `from`/`to` reais
para `GET /api/lead-folders/:id/metrics`, com um seletor de período reutilizável (o
mesmo padrão de componente pode servir tanto a métricas de pasta quanto,
futuramente, ao dashboard geral).

## 6. Alterações na interface

### 6.1 Estrutura da aba Leads

`LeadsPage.tsx` deixa de ser um componente único de formulário+tabela e passa a ter:

1. Cabeçalho: total de pastas / pastas ativas (`"3 pastas ativas · distribuição em rodízio"`
   quando `active_folder_count > 1`).
2. Coluna lateral com os cards de pasta (seção 6.2).
3. Área de métricas da pasta selecionada (consome `GET /api/lead-folders/:id/metrics`).
4. Área de importação e cadastro (seção 6.3/6.4), escopada à pasta selecionada.
5. Tabela de leads da pasta (`DataTable`, reaproveitando
   [DataTable.tsx](apps/web/src/components/DataTable.tsx)).
6. Indicador de fila ativa (reaproveita `status.folder_queue_summary` do discador).

### 6.2 Cards de pasta

Cada card mostra nome, badge ativa/inativa (`Badge` de [ui](apps/web/src/components/ui.tsx)
— mesmo componente do resto do app), total de leads, leads prontos, tentativas no
período, taxa de atendimento, toggle de ativação (`PATCH /api/lead-folders/:id`),
botão "ver métricas" (seleciona a pasta) e menu (renomear / arquivar / limpar).

### 6.3 Importação

- Passa a exigir pasta de destino **antes** de escolher o CSV: seletor de pasta (com
  opção "criar nova pasta" inline, chamando `POST /api/lead-folders` e selecionando o
  resultado) acima do `<input type="file">`.
- `importCsv` em App.tsx passa a enviar para `POST /api/lead-folders/:folderId/import`
  em vez de `POST /api/leads/import`.
- O resultado exibido (`importResult`, hoje só `imported`/`skipped`) ganha
  `duplicated`, `updated` e, se aplicável, `limit_exceeded` — todos já calculáveis a
  partir da mesma lógica de `existingPhones` em `leads.controller.ts` (seção 3.2).

### 6.4 Cadastro manual

O formulário atual (`leadForm` em App.tsx, campos `name`/`phone`) ganha um seletor de
pasta, pré-selecionado com a pasta atualmente aberta na tela. `createLead` passa
`folderId` no corpo do `POST`. Sem pasta selecionada, o botão "Adicionar lead" fica
desabilitado (mesmo padrão de `disabled` já usado no botão de limpar quando
`!leads.length`).

### 6.5 Tabela

- Nova coluna "Pasta" em `DataTable`, exibida apenas quando o usuário está na visão
  "Todas as pastas" (uma pasta virtual que agrega `GET /api/leads` sem filtro, usando
  os campos `folder_name` já adicionados na seção 3.3).
- Ações atuais mantidas (`Ligar agora`, `Resetar`, `Remover`), mesma lógica de
  `disabled` já existente em [LeadsPage.tsx:19](apps/web/src/features/leads/LeadsPage.tsx).
- "Ligar agora" para lead de pasta inativa: botão continua desabilitado (mesma
  condição `!['queued','retry_wait'].includes(row.status)` não cobre isso hoje — passa
  a checar também `row.folder_is_active`), com `title` explicando o motivo, mesmo
  padrão já usado para `callInProgress` nos botões "Resetar"/"Remover".

### 6.6 Limpeza

Substitui o botão único "Limpar contatos" (`clearLeads`, App.tsx linha 142) por duas
ações:

- **Limpar leads desta pasta** → `DELETE /api/lead-folders/:id/leads`, confirmação
  igual à atual (`window.confirm`).
- **Limpar todas as pastas** → `DELETE /api/leads` (mantido para este caso), com
  confirmação reforçada (segundo `window.confirm` ou digitação do nome da empresa —
  decisão de UX na implementação; o requisito funcional é "mais fricção que o caso de
  pasta única").

Ambas mantêm a trava atual de bloquear quando há chamadas ativas
(`LeadsController.clear`, linha 106-107), escopada à pasta no primeiro caso.

## 7. Tipagem e organização do frontend

Hoje `AnyRow = Record<string, any>` é usado amplamente (11 arquivos, incluindo
`LeadsPage.tsx` e `App.tsx`). Nesta implementação, introduzir em
[types/index.ts](apps/web/src/types/index.ts):

```ts
export type LeadFolder = {
  id: string;
  name: string;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
  deactivated_at: string | null;
};

export type LeadFolderSummary = LeadFolder & {
  total_leads: number;
  ready_leads: number;
  attempts_in_period: number;
  answer_rate: number;
};

export type LeadFolderMetrics = {
  total_leads: number;
  queued_leads: number;
  retry_wait_leads: number;
  completed_leads: number;
  blocked_leads: number;
  total_attempts: number;
  calls_answered: number;
  answer_rate: number;
  calls_no_answer: number;
  calls_failed: number;
  calls_in_progress: number;
  result_distribution: Record<string, number>;
  pipeline_distribution: Record<string, number>;
  last_import: { at: string; imported: number } | null;
};

export type Lead = {
  id: string;
  folder_id: string;
  folder_name?: string;
  folder_is_active?: boolean;
  name: string;
  phone: string;
  status: string;
  attempts: number;
  next_eligible_at: string;
  do_not_call: boolean;
  pipeline_stage: string;
  created_at: string;
};

export type LeadImportResult = {
  imported: number;
  skipped: number;
  duplicated: number;
  updated: number;
  total: number;
  limit_exceeded?: boolean;
};
```

`AnyRow` continua existindo para o restante do app (fora de escopo desta entrega),
mas os novos componentes (`LeadFoldersSidebar`, `LeadFolderMetricsPanel`,
`LeadFolderImportForm`) usam os tipos acima em vez de `AnyRow`.

Separar de `App.tsx` (hoje um único componente concentrando todo o estado, linhas
29-149) um hook dedicado, por exemplo `apps/web/src/features/leads/useLeadFolders.ts`,
com:

- estado de pastas (`folders`, `selectedFolderId`);
- estado de leads da pasta atual (`leads`, `leadsLoading`);
- estado de métricas da pasta atual (`metrics`, `metricsRange`);
- as operações (`createFolder`, `renameFolder`, `toggleFolderActive`, `archiveFolder`,
  `createLead`, `importCsv`, `clearFolderLeads`, `clearAllLeads`, `manualCall`,
  `resetLead`, `removeLead`).

`App.tsx` passa a consumir esse hook e repassar os valores para `LeadsPage`, do mesmo
jeito que hoje repassa `leads`/`leadForm`/etc — sem mudar o padrão geral de
"estado no App, componente burro na feature", só extraindo a fatia de leads para fora
do componente principal.

### 7.1 Ordem de carregamento

1. Buscar pastas (`GET /api/lead-folders`, com resumo embutido).
2. Selecionar a pasta atual (preferência salva, ou a primeira ativa, ou a pasta
   padrão).
3. Buscar os leads daquela pasta (`GET /api/lead-folders/:id/leads`).
4. Buscar métricas da pasta (`GET /api/lead-folders/:id/metrics`).
5. No polling periódico (mesmo mecanismo de `load()` já usado em App.tsx para
   `status`/`numbers`/`sdrs`/`calls`), repetir 1, 3 e 4 preservando
   `selectedFolderId` — nunca resetar a seleção do usuário a cada refresh.

## 8. Testes necessários

Seguindo o padrão de specs já existente (`dialer.rules.spec.ts`,
`lead-import.spec.ts` — testes de unidade sobre funções puras, sem mock de banco):

**Banco e isolamento**
- Pastas de um tenant não aparecem para outro (`GET /api/lead-folders` escopado por
  `tenant_id`, mesmo padrão de todos os outros endpoints).
- Nome duplicado (case-insensitive) rejeitado dentro do tenant; mesmo nome permitido
  em tenants diferentes (constraint `lead_folders_tenant_name_unique`).
- Backfill da migration 010: todo lead existente recebe a pasta padrão; toda chamada
  histórica recebe a pasta do lead correspondente (ou a padrão, se o lead foi
  removido).

**Ativação**
- Pasta inativa não aparece na query de `tick()` (seção 4.1) — teste de unidade sobre
  a função extraída de `dialer.rules.ts` que decide elegibilidade por pasta,
  equivalente a `leadIsEligible` mas com `folderIsActive` como parâmetro adicional.
- Múltiplas pastas ativas simultaneamente funcionam.
- Desativar uma pasta não interrompe `startReservedCall` já em andamento (a
  revalidação da seção 4.2 só afeta reservas **novas**).
- Nenhum lead é reservado após desativação (teste de integração no
  `dialer.service.spec.ts`, cobrindo a corrida da seção 4.2).
- Sem pasta ativa, `getStatus().next_action === 'Nenhuma pasta ativa'`.

**Rodízio**
- Leads de múltiplas pastas ativas saem intercalados (teste de unidade sobre a query/
  função de seleção, com fixtures de 3 pastas e volumes desiguais — replica o exemplo
  da seção 1).
- Pasta vazia não bloqueia as demais.
- Limite global de chamadas continua respeitado com pastas (não deve haver mudança de
  comportamento no `RedisService.reserve`, já testado indiretamente hoje).
- Mesmo lead não é reservado duas vezes em concorrência (`FOR UPDATE SKIP LOCKED`,
  seção 4.1 — teste de concorrência disparando dois `tick()` em paralelo).

**Importação**
- Leads importados ficam vinculados à `folder_id` correta.
- CSV inválido continua rejeitado (`parseLeadCsvRow` não muda — reaproveita
  `lead-import.spec.ts` como está).
- Telefone já existente em outra pasta não é duplicado nem movido; entra em
  `duplicated`.
- Resultado da importação informa todos os totais (`imported`, `skipped`,
  `duplicated`, `updated`).
- Limite de leads da empresa (`tenants.max_leads`, já checado em
  `leads.controller.ts`) continua respeitado, agora contando o total do tenant
  (não por pasta).

**Métricas**
- Números filtrados corretamente por `folder_id`.
- `from`/`to` aplicados corretamente ao filtro de `calls.created_at`.
- Chamadas históricas (pré-migration) continuam vinculadas à pasta correta após o
  backfill.
- Taxa de atendimento calculada com a mesma fórmula da seção 5.
- Leads sem chamadas não quebram os indicadores (contagens em zero, não `NULL`/erro).

## 9. Ordem recomendada de execução

**Fase 1 — Banco e contratos**
- `010_lead_folders.sql` (tabela, colunas, backfill, constraints, índices).
- DTOs (`create-lead-folder.dto.ts`, `update-lead-folder.dto.ts`, seguindo o padrão
  de `create-lead.dto.ts`) e tipos de resposta.

**Fase 2 — API de pastas**
- Módulo `lead-folders` (CRUD, listagem com resumo).
- Importação e criação de leads por pasta (reaproveitando `lead-import.ts`).
- Auditoria (eventos da seção 3.5).
- Métricas (`GET /api/lead-folders/:id/metrics`).

**Fase 3 — Discador**
- Query de seleção com `JOIN lead_folders` + rodízio (seção 4.1).
- Revalidação de `is_active` na reserva (seção 4.2), gravação de `folder_id` em
  `calls`.
- `getStatus()` com os novos campos (seção 4.3).

**Fase 4 — Interface**
- Navegação entre pastas, cards, ativação múltipla.
- Importação com seleção de destino.
- Painel de métricas por pasta com filtro de data real.
- Tabela com coluna "Pasta" na visão agregada.
- Limpeza com escopo explícito (por pasta / todas).

**Fase 5 — Testes e rollout**
- Specs de API e discador (seção 8).
- Migração testada com uma cópia dos dados de desenvolvimento.
- Teste de concorrência com múltiplas pastas ativas (`FOR UPDATE SKIP LOCKED`).
- Validação responsiva da nova tela de Leads.
- Deploy com a pasta padrão ativa e todos os dados existentes preservados (a migration
  já garante isso via backfill — não há passo manual de "ativar pasta padrão" em
  produção).

## 10. Critérios de aceite

- Organizador consegue criar várias pastas.
- Consegue importar leads escolhendo a pasta de destino.
- Consegue ativar duas ou mais pastas simultaneamente.
- Discador trabalha somente com pastas ativas (`lead_folders.is_active = true` na
  query de seleção e na reserva).
- Rodízio entre pastas funciona sem duplicar chamadas (`FOR UPDATE SKIP LOCKED` +
  lock por tenant já existente em `tick()`).
- Desativar uma pasta não apaga dados nem interrompe chamadas existentes.
- Cada pasta tem métricas próprias por período.
- A pasta padrão preserva todos os leads atuais (garantido pelo backfill da
  migration 010).
- A regra de duplicidade de telefone continua segura por empresa
  (`leads_tenant_phone_unique` inalterada).
- A interface informa claramente qual pasta está ativa, pausada e sendo analisada.

## 11. Decisões assumidas / pontos em aberto

- Um telefone pertence a no máximo uma pasta por empresa (regra padrão assumida,
  igual ao enunciado original).
- `call_result` permanece texto livre nesta fase; nenhuma taxa de conversão
  automática é calculada até haver taxonomia padronizada — só distribuição bruta.
- O cursor de rotação justa entre pastas (`folder_rotation_cursor`) é um refinamento
  da Fase 3, não um bloqueador do rodízio básico.
- Tabela de métricas agregadas fica como evolução futura, não faz parte desta
  entrega.
