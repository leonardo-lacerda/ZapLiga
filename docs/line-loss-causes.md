# Por que cada linha caiu

Antes, o ZapLiga só conhecia duas quedas (`device_removed` e `account_locked`), e todo o resto aparecia como "a linha caiu". Agora cada sinal que o WhatsApp manda sobre a saúde de uma linha vira uma linha em `line_loss_events` (migration 082), com a causa, o código e o que o servidor disse.

## De onde vêm os sinais

Uma linha do ZapLiga é um **aparelho companheiro**: nunca passa pelo registro por SMS do celular. Por isso os motivos de registro (`blocked`, `stale`...) não chegam pelo Waxum. O que chega é a linguagem da própria conexão:

| Sinal (evento do Waxum) | Imagem | Causa |
|---|---|---|
| `account_locked` (falha 403), com `data.details` | todas; o motivo só a partir da v10 | `account_locked` |
| `logged_out` com `conflict=device_removed` | todas | `device_removed` |
| `logged_out` com outro `conflict` (ex.: `replaced`) | v7+ | `transient` |
| `logged_out` com `reason` `LoggedOut`/`UnknownLogout` | v7+ | `logged_out_other` |
| `temp_banned` (falha 402: `code` 101-106 e `expire_secs`) | v10 | `temp_banned` |
| `connect_failure` 405/409/413/414/418 | v10 | `client_rejected` (problema técnico, não da linha) |
| `connect_failure` 500/503, `stream_error` (menos 515) | v10 / todas | `transient` |
| `call_ack` com `error=463` | v8+ | `reachout_timelock` |
| ligação que abre e morre sem áudio e sem 463 | todas | `media_failure` |
| informado pelo operador no card | — | `registration` (com `registration_reason`) |

O motivo de um bloqueio (`violation_reason`, `vt`, `location`, o texto do servidor) é guardado só para leitura. O `appeal_token` e o `idv_token` são descartados ainda no Waxum: são credenciais de uso único, não uma causa, e a apelação está fora do escopo.

## O que o discador faz com cada causa

Com `LINE_LOSS_POLICY=v2` (variável da API; `LINE_LOSS_POLICY_TENANTS=id1,id2` limita a algumas empresas):

| Causa | Ação |
|---|---|
| `device_removed`, `account_locked` | Sai do discador e do pool; não reconecta sozinha; conta para aposentar (igual a antes) |
| `temp_banned` | Não disca até o fim do banimento (`expire_secs`; sem prazo, 24 h) e não reconecta |
| `reachout_timelock` | Não disca até `time_enforcement_ends`, consultado no servidor (`GET /sessions/{id}/reachout-timelock`, v10); a sessão continua conectada. Sem resposta do servidor, 6 h (o comportamento antigo) |
| `media_failure` | Pausa curta (30 min) em vez de 6 h |
| `logged_out_other` | Precisa de QR novo; não reconecta sozinha |
| `client_rejected`, `transient`, `unknown` | Só registra; `client_rejected` gera alerta técnico |

O bloqueio de discagem fica em `whatsapp_numbers.dial_blocked_until` / `dial_block_cause`, separado do `flagged_until` (que também guarda o bloqueio de 24 h após o pareamento e o descanso do canário). Sem a variável, o discador segue com as 6 h fixas de antes.

## Como acompanhar

- Card da linha: causa, ação recomendada e "pausada até".
- Topo da página Números: quedas dos últimos 30 dias por causa.
- SQL: `SELECT cause, count(*) FROM line_loss_events WHERE tenant_id = $1 AND occurred_at > now() - interval '30 days' GROUP BY cause`.
