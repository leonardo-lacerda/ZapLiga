# Integração com CRM (Franco) — contrato v1

Permite que um CRM (primeiro consumidor: **Franco**, fork do Chatwoot) faça ligações pelo ZapLiga a partir da tela do lead. O agente fala pelo navegador do CRM, que funciona como uma **estação ZapLiga só-manual**.

Plano completo, incluindo o lado Franco: `Franco/plano-integracao-zapliga.md`.

Status: **Z1–Z4 implementados** (chave, API v1, estação só-manual, intenção de discagem e webhooks para o CRM). Nada disso está em produção.

## Como funciona

1. **Chave.** Um líder abre **Integrações → Ligações pelo Franco** e gera a chave `zpl_crm_…`. Ela é mostrada uma vez e guardada só como hash.
   - Feature `crm_integration`, liberada nos planos Growth e Pro.
   - O admin da plataforma pode liberar para outros tenants em "Recursos da empresa".
2. **Handshake.** O servidor do CRM chama `POST /api/v1/integrations/handshake` com a URL do webhook e as origens do navegador. Recebe um `webhook_secret`, mostrado uma vez.
3. **Vínculo de agentes.** Para cada usuário que vai ligar, o CRM chama `POST /agents/ensure`, que vincula por e-mail:
   - SDR ou líder que já existe: mantém o papel e não consome assento novo;
   - qualquer outra pessoa: vira **SDR do tenant e ocupa 1 assento**.
4. **Estação.** O CRM pede `POST /agents/:sdrId/station-ticket` e entrega ao navegador `{ws_url, ticket}`. O navegador abre `ws_url?ticket=…` e envia `identify`.
   - A estação fica com `station_mode = 'manual_only'`.
   - O discador automático **nunca** entrega ligações a ela, e `availability: true` é recusado.
5. **Ligar.**
   1. O servidor do CRM valida as próprias permissões e chama `POST /dial-intents`. Recebe `intent_id`, de uso único e válido por 60 s.
   2. O navegador envia `{type:'dial', intentId}` pelo socket da estação.
   3. A instância que segura o socket faz a ligação pela **linha escolhida**, sem trocar por outra.
6. **Áudio** segue o protocolo normal da estação: PCM16 LE mono 16 kHz, em quadros binários no mesmo socket.
7. **Desligar e pós-ligação.**
   - Desligar: `{type:'hangup', callId}` no socket, ou `POST /calls/:id/hangup`, que alcança a instância dona via Redis pub/sub.
   - Pós-ligação: `POST /calls/:id/wrap-up`.
   - Se o CRM não enviar o pós-ligação, a pausa é liberada sozinha na próxima discagem do agente.

Por que a discagem vai pelo socket: a estação vive em memória na instância (`api-a`/`api-b`) que segura o WebSocket, e o `ip_hash` do nginx não garante que a chamada servidor→servidor do CRM caia na mesma instância.

## Autenticação

O header é `Authorization: Bearer zpl_crm_…` ou `x-zapliga-api-key: zpl_crm_…`.

- A chave sozinha define o tenant: rota ou header nenhum muda isso.
- Escopos: `calls`, `numbers:read`, `numbers:write`, `agents`, `webhooks`. Hoje toda chave recebe todos.
- Limite de requisições: 600 por minuto por integração (`CRM_INTEGRATION_RATE_LIMIT_PER_MINUTE`). Acima disso, responde `429` com `code: rate_limited`.

| Situação | Resposta |
|---|---|
| Chave ausente, inválida ou revogada | `401` |
| Escopo faltando | `403` com `code: missing_scope` |
| Feature desligada para o tenant | `409` com `code: feature_disabled` |

Erros de discagem retornam `409` com `{code, message, retry_after_seconds}`.

## Rotas — `https://api.zapliga.com/api/v1/integrations`

| Método e rota | Escopo | Corpo / resposta |
|---|---|---|
| `GET /me` | — | `{contract_version, tenant, integration, access, seats}` |
| `POST /handshake` | `webhooks` | `{webhookUrl, allowedOrigins?, externalAccountId?}` → `{integration, webhook_secret, contract_version}` |
| `GET /catalog` | — | `{call_results[{code,label,default_pipeline_stage,requires_notes,requires_callback_at}], pipeline_stages}` |
| `GET /numbers` | `numbers:read` | `{items[{id,label,phone,status,in_call,available_at,quarantined_until,protection}]}` |
| `POST /numbers` | `numbers:write` | `{label, phone?}` → linha (depois, buscar o QR) |
| `GET /numbers/:id/qr` | `numbers:write` | Payload do Waxum (`qr`/`qr_codes`, `status: connected` quando pareado) |
| `POST /numbers/:id/reconnect` | `numbers:write` | — |
| `PATCH /numbers/:id/settings` | `numbers:write` | `{label?, cooldownSeconds?, maxCallsPerWindow?, callWindowSeconds?}` |
| `DELETE /numbers/:id` | `numbers:write` | Arquiva a linha (recusa se estiver em ligação) |
| `GET /agents` | `agents` | Vínculos com estado da estação |
| `POST /agents/ensure` | `agents` | `{externalUserId, email, name}` → `{sdr_id, user_id, operator_kind, provisioned, external_user_id}` |
| `DELETE /agents/:sdrId/link` | `agents` | Desvincula; libera o assento se a integração o criou |
| `POST /agents/:sdrId/station-ticket` | `calls` | `{ticket, expires_at, ws_url, tenant_id, sdr_id}` (60 s, uso único) |
| `POST /dial-intents` | `calls` | `{sdrId, numberId, phone, name?, externalRef?, leadExternalId?}` → `{intent_id, expires_at}` |
| `GET /calls?external_call_id=&limit=&offset=` | `calls` | Ligações desta integração (`external_call_id` = `external_ref.call_id`) |
| `GET /calls/:id` | `calls` | Ligação com status, durações, linha, resultado e `external_ref` |
| `POST /calls/:id/hangup` | `calls` | `202`; encaminha à instância dona |
| `POST /calls/:id/wrap-up` | `calls` | `{callResult, pipelineStage?, notes?, callbackAt?}` |
| `POST /suppressions` | `calls` | `{phone, reason?, notes?}` → registra na lista de não contato |

Detalhes por rota:

- **`POST /handshake`** gera um segredo novo a cada chamada. URLs e origens precisam ser HTTPS; HTTP é aceito só para `localhost`/`*.test` com `NODE_ENV` development ou test.
- **`POST /dial-intents`**:
  - `externalRef` é um objeto plano de até 12 campos, com valores texto (≤ 200) ou número. Ele é devolvido nos eventos da estação e em `/calls`. Convenção do Franco: `{account_id, call_id, contact_id, lead_id, conversation_id, user_id}`.
  - `leadExternalId` só é usado quando o ZapLiga precisa criar o lead "sombra".
- **`POST /calls/:id/wrap-up`**:
  - A etapa padrão é derivada do resultado.
  - `retornar` exige `callbackAt` futuro.
  - `nao_ligar_novamente` suprime o número.
  - Se a pausa já foi liberada, responde `409` com `code: wrap_up_closed`.
- **Suprimir não tem rota de remoção, de propósito:** retirar um "não ligar" é decisão humana no painel do ZapLiga.

### Códigos de recusa da discagem

Os mesmos códigos valem para `POST /dial-intents` (`409`) e para a mensagem `dial_failed` do socket.

| Code | Significado |
|---|---|
| `agent_not_linked` (404) | O `sdrId` não pertence a esta integração |
| `agent_not_eligible` | O operador perdeu o acesso (membership removida, papel mudou) |
| `station_offline` | O navegador do agente não está com a estação conectada |
| `agent_busy` | O agente já está numa ligação |
| `line_not_found` / `line_disconnected` | A linha não existe ou não está pareada |
| `line_quarantined` | Quarentena por sinais de bloqueio (`retry_after_seconds`) |
| `line_protected` | Backoff de proteção do WhatsApp (`retry_after_seconds`) |
| `line_busy` | A linha já está em ligação |
| `self_call` | O destino é a própria linha |
| `suppressed` | O número está na lista de não contato |
| `invalid_phone` / `invalid_external_ref` | Entrada inválida |
| `outside_dialer_schedule` | Fora da janela de horário do tenant |
| `intent_expired` / `intent_mismatch` | Só no socket: intenção vencida, já usada ou de outro agente |

## Mensagens do socket da estação

Além do protocolo normal da estação (`connected`, `identified`, `call_reserved`, `call_started`, `media_open`, `media_active`, `call_finished`, `error`, …):

| Direção | Mensagem |
|---|---|
| navegador → servidor | `{type:'identify'}`, `{type:'dial', intentId}`, `{type:'hangup', callId}` |
| servidor → navegador | `{type:'dial_accepted', intentId, callId, leadId}` |
| servidor → navegador | `{type:'dial_failed', intentId, code, message, retryAfterSeconds?}` |
| servidor → navegador | `call_reserved` também traz `externalRef` nas ligações da integração |

Um operador tem uma estação por vez. Se o mesmo usuário abrir a estação em outro lugar (outra aba do CRM ou o painel do ZapLiga), o socket anterior é fechado com código `4000` ("nova sessao SDR conectada"). O CRM deve mostrar isso e não reconectar sozinho em loop.

## Dados

- **Migration** `062_crm_integrations.sql`:
  - tabelas `crm_integrations` e `crm_integration_agents`;
  - colunas novas `websocket_tickets.integration_id`, `sdrs.station_mode`, `calls.integration_id` e `calls.external_ref`;
  - feature `crm_integration` (coluna legada, catálogo de planos e snapshots de Growth/Pro).
- **Migration** `063_crm_integration_events.sql`: fila `crm_integration_events` (outbox dos webhooks, com lease de entrega) e colunas `last_delivery_at`/`last_delivery_failure_at` em `crm_integrations`.
- **Leads criados por ligações do CRM** vão para a pasta **"Franco CRM"**, com status `manual` (fora da fila automática) e `external_id`. Eles contam na cota de leads do plano.
- **Origens do navegador:** se a integração declarou `allowed_origins`, o upgrade do WebSocket de um ticket da integração exige `Origin` igual a uma delas. Integração revogada não abre estação.

## Webhooks ZapLiga → CRM

O ZapLiga entrega eventos na `webhookUrl` registrada no handshake.

**Requisição:** `POST` com JSON e os headers:
- `x-zapliga-event-id`
- `x-zapliga-event-type`
- `x-zapliga-timestamp` (segundos Unix)
- `x-zapliga-signature: sha256=<hex>`
- `idempotency-key`

**Assinatura:** `HMAC-SHA256(webhook_secret, "<timestamp>.<corpo bruto>")`.
- O CRM deve comparar em tempo constante.
- Deve rejeitar timestamps com mais de 5 minutos de diferença.
- Deve responder `2xx` rápido e processar depois.

**Envelope:**

```json
{ "id": "…", "type": "call.ended", "schemaVersion": 1, "occurredAt": "2026-10-15T01:02:03.000Z",
  "tenantId": "…", "integrationId": "…", "payload": { "call": { … } } }
```

| Evento | Quando | `payload` |
|---|---|---|
| `call.reserved` | A ligação da integração foi reservada (linha + agente) | `{call}` |
| `call.dialing` | O WhatsApp começou a chamar o destino | `{call}` |
| `call.answered` | O destino atendeu | `{call, answered_at}` |
| `call.ended` | Terminou (`status`: `completed`/`no_answer`/`failed`/`cancelled`, mais `outcome` e `failure_reason`) | `{call}` |
| `call.wrap_up_completed` | Pós-ligação registrado no ZapLiga | `{call, callback_at}` |
| `number.created` / `number.updated` / `number.removed` | Linha criada, ajustada ou arquivada | `{number}` |
| `number.status_changed` | Linha conectou, desconectou ou entrou em quarentena | `{number}` |
| `integration.ping` | Enviado após cada handshake e por `POST /webhook/test` | `{message}` |

**Conteúdo dos payloads:**
- `call` tem o mesmo formato de `GET /calls/:id`: status, durações, `to_phone`, `lead_name`, `number{id,label,phone,available_at,quarantined_until}`, `sdr{id,name,external_user_id}`, `external_ref`, resultado e notas.
- `number` tem o mesmo formato de `GET /numbers`.
- Eventos de ligação só vão para a integração que fez a ligação.
- Eventos de linha vão para todas as integrações conectadas do tenant.

**Entrega:**
- **Pelo menos uma vez.** Retry com backoff exponencial (2 s, 4 s … até 15 min). Depois de 10 tentativas, cerca de 1 h, o evento vai para dead-letter.
  - Redirecionamentos (3xx) contam como falha.
  - Cada evento é postado por uma instância de cada vez.
- **Ordem não garantida.** Cada evento traz o estado completo da ligação ou da linha. O CRM deve deduplicar pelo `id` do evento e ficar com o estado mais recente (`occurredAt`).
- **Retenção:** eventos entregues ficam 30 dias.
- **Consulta e reenvio:** `GET /events?status=dead_letter` e `POST /events/:id/retry`, ou pelo card no painel.
- **Endereço do webhook:** em produção não pode apontar para endereço interno (IP privado, loopback ou `localhost`).

| Método e rota | Escopo | Uso |
|---|---|---|
| `POST /webhook/test` | `webhooks` | Enfileira um `integration.ping` |
| `GET /events?status=&limit=` | `webhooks` | Últimas entregas (`pending`/`delivered`/`dead_letter`) |
| `POST /events/:id/retry` | `webhooks` | Recoloca um evento na fila |

Painel do ZapLiga: o card da integração mostra a última entrega, o aviso de falhas e a lista "Ver entregas", com **Reenviar** para os eventos que falharam.

## Pendências

- Métricas Prometheus específicas (`integration_requests_total`, `dial_intents_total{result}`, `crm_events_delivery_failures_total`).
- Resolver DNS do webhook antes de entregar (hoje só IPs literais internos são bloqueados).
