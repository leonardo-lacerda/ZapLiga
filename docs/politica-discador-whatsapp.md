# Política local do discador e proteção do WhatsApp

Esta política foi implementada localmente e ainda não foi publicada em produção. Ela trata a chamada como um recurso compartilhado: uma linha não pode ser usada por dois SDRs e o mesmo número não pode receber uma nova tentativa enquanto a cadência da conta estiver protegida.

## Regras efetivas

1. **Uma chamada por sessão Waxum.** Toda reserva usa o `waxum_session_id` como lock global. Isso vale para discador automático, ligação manual por lead e ligação manual por telefone.
2. **Limite de concorrência.** O limite global da operação, o limite da linha, o SDR, o lead, o número e a sessão são verificados atomicamente no Redis. A liberação é idempotente.
3. **Cooldown entre chamadas.** Depois de qualquer término, a linha respeita `cooldown_seconds` (padrão: 60 s). Ligações manuais obedecem à mesma proteção do discador automático.
4. **Ritmo global do discador.** A operação tem `max_calls_per_minute` (padrão: 6) e `min_seconds_between_calls` (padrão: 10 s). A reserva Redis só passa quando os dois limites são respeitados; a regra vale para chamadas manuais e automáticas e funciona entre múltiplas instâncias da API.
5. **Janela móvel por linha.** Cada linha tem `max_calls_per_window` (padrão: 3) em `call_window_seconds` (padrão: 180 s). A tentativa é registrada no momento da reserva e permanece na janela mesmo se cair rapidamente; isso evita que uma sequência de falhas seja convertida em spam de novas tentativas. A contagem é atômica no Redis e expira sozinha.
6. **Queda rápida.** Se a mídia fecha em menos de 5 s, sem áudio e sem sinal de atendimento, a linha recebe uma ocorrência. A primeira ocorrência aplica backoff de 180 s; duas ocorrências dentro de 24 h pausam a linha por 6 h. Uma chamada que chega a áudio limpa a sequência.
7. **429 do Waxum/WhatsApp.** O `wait for Ns` é respeitado com backoff entre 180 e 600 s, e o lead volta à fila sem consumir tentativa automática. O relógio é persistido em `last_call_ended_at` para sobreviver a reinício da API.
8. **Tentativas do lead.** O limite existente (`max_attempts_per_lead`) continua valendo; uma falha transitória de cadência não consome esse orçamento.

## Defaults para validar pela manhã

| Parâmetro | Default local | Motivo |
| --- | ---: | --- |
| `max_concurrent_calls` por linha | 1 | Uma sessão WhatsApp/Waxum fica dedicada a uma conversa. |
| `global_max_concurrent_calls` | 1 | Mantém o comportamento atual até a operação confirmar mais linhas aquecidas. |
| `max_calls_per_minute` | 6 | Limite total de novas chamadas da operação. |
| `min_seconds_between_calls` | 10 s | Evita uma rajada mesmo quando há várias linhas disponíveis. |
| `cooldown_seconds` | 60 s | Espaçamento mínimo entre tentativas da mesma linha. |
| `max_calls_per_window` | 3 | Evita rajadas, inclusive de quedas rápidas. |
| `call_window_seconds` | 180 s | Janela conservadora alinhada ao backoff observado de rate limit. |
| queda rápida | 5 s / 180 s | Detecta encerramento antes de mídia e reduz repetição. |
| quarentena | 2 ocorrências em 24 h / 6 h | Retira a linha da rotação quando há sinal repetido de bloqueio. |

Os valores não são uma garantia oficial do WhatsApp; são um ponto de partida seguro para medir a operação. Ajuste o ritmo global via `PATCH /api/dialer/settings`, usando `max_calls_per_minute` e `min_seconds_between_calls`. Ajuste a proteção por linha via `POST /api/numbers` ou `PATCH /api/numbers/:id/settings`, usando `maxCallsPerWindow` e `callWindowSeconds`. O intervalo aceito é de 1–20 tentativas e 60–3600 segundos por linha; o ritmo global aceita 1–60 chamadas/minuto e 0–3600 segundos entre chamadas.

## Cenários

- **Dois SDRs e uma sessão:** o primeiro reserva a sessão; o segundo recebe “limites de chamadas ocupados” e não inicia uma chamada concorrente.
- **Dois SDRs e duas sessões:** cada SDR pode usar uma sessão diferente, desde que o limite global permita (`global_max_concurrent_calls = 2`).
- **Ritmo global:** com `max_calls_per_minute = 6` e `min_seconds_between_calls = 10`, a operação pode iniciar no máximo seis chamadas em qualquer minuto e nunca inicia duas com menos de dez segundos de diferença.
- **Queda rápida:** a chamada é encerrada, a linha fica em backoff e o lead automático retorna à fila; não há rediscagem imediata.
- **Uma linha atingiu a janela:** outras linhas conectadas continuam elegíveis. Quando todas estiverem protegidas, o status informa que o discador está aguardando a proteção da linha.

## Validação local e rollout

1. Aplicar as migrations `040_whatsapp_dialer_rate_limits.sql` e `041_dialer_pacing_limits.sql` no banco local.
2. Fazer chamadas de teste com números autorizados e observar `calls_started_total`, `waxum_rate_limited`, encerramentos rápidos e o status de cada linha.
3. Confirmar que uma chamada finalizada libera o lock de sessão e que uma chamada bloqueada não cria registro em `calls`.
4. Ajustar a cadência por linha somente após observar 30–60 minutos de métricas.
5. Só depois repetir os testes em staging e planejar um deploy controlado. Nenhuma alteração deste plano foi aplicada à produção nesta etapa.
