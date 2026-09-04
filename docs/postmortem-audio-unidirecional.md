# Postmortem — áudio unidirecional nas chamadas (cliente fala, SDR não ouve)

**Período:** 2026-09-02 (noite) → 2026-09-04 01:31 UTC (resolvido e confirmado).
**Impacto:** toda chamada de saída atendida ficava unidirecional: o lead ouvia o SDR, o SDR ouvia silêncio absoluto. Operação de discagem inutilizada.
**Status:** resolvido em produção, validado com chamada real e contadores do servidor.

Este documento existe para que o problema **não seja re-diagnosticado do zero**. Ele diz o que era, por que demorou, como foi corrigido e — principalmente — como saber em 1 minuto, pelos logs, em qual camada um novo silêncio está.

---

## 1. Resumo em uma frase

O Waxum se conectava a **um único** relay de mídia do WhatsApp, mas o telefone que atende escolhe o próprio relay depois do accept e enviava a voz dele para **outro host** da mesma oferta — onde ninguém nosso estava ouvindo. Depois de corrigido isso, uma segunda camada (fone Bluetooth mudo no perfil Stereo) e uma terceira (um override de deploy revertendo a imagem) precisaram cair também.

---

## 2. O sintoma, com os números que o definem

Em toda chamada afetada o log do discador ("Diagnóstico de reprodução", Redis `zapcall:tenant:<id>:dialer:logs`) mostrava:

```
cliente→servidor pico=0, amostras não-zero=0/N      ← voz do cliente nunca chegou ao servidor
SDR→cliente    pico=32768, amostras não-zero=…/N    ← voz do SDR chegando normalmente
```

e o Waxum registrava, ~3 s depois do atendimento:

```
WARN wacore::voip::engine: voip audio health event=AudioReceptionStalled { silent_for_ms: 3004 }
```

`AudioReceptionStalled` (e não `AudioSilent`) significa, pelo código do engine (`wacore/src/voip/media_stats.rs`), que **zero pacotes RTP do peer chegaram** — não é problema de chave, codec ou decodificação (esses gerariam `AudioSilent` com contadores). Essa distinção sozinha eliminou metade das hipóteses.

---

## 3. O que NÃO era (todas descartadas com evidência — não retestar)

| Hipótese | Por que foi descartada |
|---|---|
| Headset / PC / navegador do SDR | Contadores do **servidor** já mostravam `pico=0`; o áudio nunca chegava ao navegador. Testado em 3 PCs, 3 headsets, 3 usuários. |
| Conta do WhatsApp marcada / IP da VPS | Mesma conta rodando de outro IP (rede doméstica) → mesmo resultado. 3 números diferentes → mesmo resultado. E o issue upstream [#1098](https://github.com/oxidezap/whatsapp-rust/issues/1098) mostra terceiros sem relação com o mesmo sintoma. |
| Firewall da VPS bloqueando a porta 3480 | Regras auditadas; egress e retorno NAT funcionando (o 3478 voltava pelo mesmo caminho). |
| Chaves SRTP/SFrame de recepção | `Stalled` ≠ `AuthFailed`; nada chegava para decifrar. (Há um code smell real em `sframe.rs:186-187` — recv key derivada do próprio LID — mas não era a causa.) |
| Escolher "melhor" o relay único (fix `relay-fna`) | Inútil por definição: qualquer relay único pode não ser o que o peer escolhe. Deployado e comprovadamente sem efeito. |

---

## 4. Causa raiz nº 1 — bind em um só relay (servidor)

O `<relay>` que o WhatsApp devolve no ack da oferta traz vários endpoints (ex.: `iad3c02`, `gig4c02`, `lga3c02`). O código:

- escolhia **um** em `wacore/src/voip/relay_parse.rs::get_media_relay_endpoint`;
- conectava só nele em `src/voip/transport/native.rs` (`RelayMediaChannelFactory`, que só variava a **porta** do mesmo host: 3478/3480).

Quem atende roda a própria eleição de relay depois do accept (mede RTT para cada endpoint da oferta) e pode migrar a mídia para um host diferente. O nosso uplink continua chegando (mandamos para o relay que escolhemos e ele recebe), mas o downlink dele nunca chega em nós. Isso bate exatamente com a assinatura: `allocate` OK, consent/pong OK, zero RTP.

A causa foi confirmada por uma implementação independente do mesmo protocolo (meowcaller, PR [#26](https://github.com/purpshell/meowcaller/pull/26)), que a diagnosticou e validou contra Android, iPhone, WhatsApp Business e WhatsApp Web — e é como o cliente oficial se comporta (`ConfigureRelays`/`Broadcast` no WaCalls).

**Correção (whatsapp-rust vendorizado, imagem `zapliga-waxum:0.12.6-multirelay-v1`):**
- `relay_parse.rs`: `get_usable_relay_endpoints()` — todos os endpoints dialáveis e com token.
- `native.rs`: `MultiRelayMediaChannelFactory` / `MultiRelayTransport` / `drive_extra_relay` — conecta e aloca em **todos** os relays (cada um com o próprio token), faz broadcast do RTP/RTCP de saída e mescla o que chegar de qualquer um. O relay primário e a máquina de estados STUN do engine ficam intactos; os extras são loops independentes, best-effort.
- `facade.rs`: `relay_extras_from_data()` alimenta os extras em `build_engine` (resposta) e `attach_outgoing_relay` (chamada de saída — o caminho do ZapCall).

**Validação:** primeira chamada após o deploy (2026-09-04 00:32 UTC): `cliente→servidor pico=28343, 272107/670720 não-zero`, sem `AudioReceptionStalled`. Confirmado de novo às 01:31 UTC (`pico=13282`) com o usuário ouvindo.

O patch completo e o processo de rebuild estão em [`infra/waxum/`](../infra/waxum/README.md).

---

## 5. Causa raiz nº 2 — fone Bluetooth no navegador

Assim que o áudio passou a chegar, o SDR ainda ouvia silêncio com fone Bluetooth. O navegador reportava reprodução bem-sucedida (`navegador=running@44100Hz … concluídos=1766 pico=28343`) — mas para um endpoint mudo.

Ao abrir o microfone do headset BT, o Windows troca o aparelho do perfil Stereo (A2DP, 44.1 kHz) para Hands-Free (HFP). O headset não roda os dois ao mesmo tempo: a saída "Stereo" — que era a **saída padrão** — fica muda. O Chrome criava o `AudioContext` nessa saída padrão e "tocava" com sucesso no vazio. O app não escolhia dispositivo de saída (`context.destination` fixo).

**Correção (apps/web):** `AudioBridge.ts` + `audioDevices.ts` — a saída segue automaticamente o `groupId` do microfone em uso (o endpoint Hands-Free de saída do mesmo fone) via `AudioContext.setSinkId` (fallback `<audio>.setSinkId`); seletor manual de microfone/saída persistido; botão **Testar som** pelo mesmo caminho da chamada; indicador ao vivo **"Recebendo a voz do cliente"**; dispositivo de saída/microfone na telemetria `audio_playback_status`, registrado pela API no "Diagnóstico de reprodução".

---

## 6. Causa raiz nº 3 — o deploy revertia a correção

Um `waxum-encfix.override.yml` fora do git em `/opt/zapliga` (resto do hotfix anterior) era aplicado pelo `deploy.yml` e pinava a imagem antiga por cima do compose. O primeiro push depois do fix recriou o Waxum com a imagem quebrada.

**Correção:** override removido (backup em `/opt/zapliga/backups/`); a imagem do Waxum é definida **só** em `docker-compose.yml`; o `deploy.yml` **falha** se o override existir; runbook ganhou a seção "Imagem do Waxum".

---

## 7. Por que demorou (lições)

1. **Três causas empilhadas**: cada correção revelava a próxima e parecia "não ter funcionado". Sem os contadores por camada, é impossível dizer qual mudou.
2. **Testes sintéticos podem custar a conta**: sondas automatizadas com PCM zerado, repetidas, coincidiram com um `AccountLocked` (403) no número original. Preferir chamadas reais, poucas, com humano falando.
3. **"Funcionou ontem" com o mesmo binário** aponta para estado externo (qual relay o WhatsApp sorteou), não para código — mas a correção certa ainda foi de código: parar de depender do sorteio.
4. **Fonte da imagem fora do repositório** é um risco em si: a correção vivia numa pasta temporária. Agora o patch e o script de build estão versionados.

---

## 8. Como diagnosticar um novo silêncio em 1 minuto

Abra o "Diagnóstico de reprodução" da chamada (log do discador / Redis) e olhe nesta ordem:

| O que o log mostra | Onde está o problema | O que fazer |
|---|---|---|
| `cliente→servidor pico=0` e `AudioReceptionStalled` no Waxum | **Servidor / relay** (voz do cliente não chegou). | Conferir se o Waxum roda a imagem multi-relay (`docker compose ps waxum`); ver "outgoing relay candidates" no log do Waxum; ver §4. |
| `cliente→servidor pico>0`, `navegador … pico>0`, indicador verde na tela, SDR sem ouvir | **Saída de áudio local** (dispositivo errado). | Painel Áudio → trocar a Saída (Bluetooth: opção Hands-Free) e usar **Testar som**. |
| `cliente→servidor pico>0` mas `navegador=sem telemetria` / `pico=0` | **Navegador** (WebSocket/AudioContext). | Ver `AudioBridge.play/enqueuePlayback`; estado do `AudioContext`. |
| `SDR→cliente pico=0` | **Microfone** do SDR. | Painel Áudio → microfone; permissão do site. |

---

## 9. Proteções que ficam

- **Servidor**: bind em todos os relays (§4); API detecta PCM zerado pós-atendimento (`WHATSAPP_INBOUND_AUDIO_STALL_*`) e recicla a sessão com trava distribuída (`docs/audio-call-fix.md`); métrica `waxum_inbound_audio_stalled`.
- **Cliente**: auto-roteamento de saída + seletor + Testar som + indicador ao vivo (§5).
- **Deploy**: imagem do Waxum só no compose; override no host faz o deploy falhar (§6); jornada E2E nº 8 exige áudio não-silencioso chegando ao WebSocket do SDR.
- **Reprodutibilidade**: patch versionado e script de build em `infra/waxum/` — a imagem pode ser reconstruída sem depender de nenhuma máquina específica.
- **Memória de projeto** do assistente registra as causas e o que não retestar.

## 10. Pendências conhecidas (fora do escopo deste incidente)

- Teste pré-existente `web_client_port_is_judged_by_the_dialed_ipv4_address` (`relay_parse.rs`) falha: a camada FNA do seletor de relay primário vence a camada de porta web-client. Não afeta o fix (todos os relays úteis são vinculados), mas merece revisão.
- `sframe.rs:186-187`: recv key do SFrame derivada do self LID (deveria ser do peer). Não causou este incidente; candidato a reportar upstream.
- Reportar a correção multi-relay no upstream `oxidezap/whatsapp-rust` (#1098) para não carregar o patch para sempre.
