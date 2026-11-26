# Versão do Waxum

## Versão em produção

- Imagem: `zapliga-waxum:0.12.6-multirelay-v4-opus` (construída por nós — **não** é a `fdciabdul/waxum`)
- Base Waxum: `imtaqin/waxum` `v0.12.5` (`c673e9867216d3448339db90a0b16509a567dae1`)
- Base whatsapp-rust: `oxidezap/whatsapp-rust` `9be10573aa47bc8dcae42918c553250879383d67` (main, 2026-09-01)
- Patches e build reproduzível: [`infra/waxum/`](../infra/waxum/README.md)
- Build e healthcheck da v3 em produção: `2026-09-09`; validação final de áudio exige uma chamada real com voz.
- v4-opus (`2026-11-18`): a v3 mais a escolha do codec por `WA_CALL_AUDIO_CODEC`
  (`mlow`, padrão da biblioteca, ou `opus`). Produção usa `opus`: o decodificador MLow
  só entende um modo e descartava os quadros de baixa taxa (`low_rate=1`) e de 10 ms que
  o celular manda com internet fraca, o que o atendente ouvia como buracos na voz do
  cliente (log: `mlow: dropping out-of-operating-point frame`). Com Opus, quem decodifica
  é a libopus. Voltar ao MLow: `WA_CALL_AUDIO_CODEC: mlow` no compose, sem rebuild.
- Rollback disponível no host: `zapliga-waxum:0.12.6-multirelay-v3` (a v3 continua carregada)

## Por que não a imagem oficial

A imagem publicada conecta a um único relay de mídia; o telefone que atende pode
migrar a mídia para outro relay da oferta e a chamada fica unidirecional (o SDR
não ouve o lead). Causa, evidência e correção em
[`postmortem-audio-unidirecional.md`](postmortem-audio-unidirecional.md).
Voltar para `fdciabdul/waxum` reintroduz o bug — o `deploy.yml` recusa um
`docker-compose.yml` que não aponte para `zapliga-waxum:`.

## Comportamentos que continuam valendo

- Middleware global de rate limit do Waxum desativado com `RATE_LIMIT_ENABLED=false`;
  a cadência é controlada pelo ZapLiga.
- O endpoint `events/tail` limita o payload a 160 caracteres e não serve para
  detectar atendimento: o ZapLiga consome `wa.events.<session_id>.incoming_call`
  no NATS JetStream e correlaciona `call_id` + `Accept`.
- O container só fica `healthy` com a conexão Rust registrada no NATS
  (`infra/waxum/healthcheck.sh`).

## Regra de atualização

Não trocar a versão automaticamente. Qualquer atualização deve:

1. ser construída fora da VPS com `infra/waxum/build.sh` e carregada com `docker load`;
2. validar QR Code, conexão da sessão, chamada manual e discador;
3. testar áudio **nos dois sentidos** com pessoa falando e conferir
   `cliente→servidor pico>0` no "Diagnóstico de reprodução";
4. confirmar limites, cooldown, retry e liberação dos locks;
5. atualizar este arquivo, `infra/waxum/README.md` e a tag no `docker-compose.yml`
   **no mesmo commit** (uma troca manual não commitada é revertida no próximo deploy).

Fontes: [imtaqin/waxum](https://github.com/imtaqin/waxum), [oxidezap/whatsapp-rust](https://github.com/oxidezap/whatsapp-rust).

## Sinais de chamada (imagem `0.12.6-multirelay-v5-signal`)

O WhatsApp removia o aparelho de linhas novas entre 1,4 e 3,8 s depois da oferta da primeira
ligação (25/11/2026). Os patches `whatsapp-rust-zapliga-signal.patch` e `waxum-zapliga-signal.patch`
existem para ler o que ele responde em vez de adivinhar, e para corrigir o encerramento:

- **Log `zapliga.call`** (nível info): o conteúdo de cada oferta (`offer call_id=… ring_devices=…
  keyed_devices=… enc_types=… privacy_token=… device_identity=… prekey_message=… audio_rate=…
  format=…`), a resposta do servidor à oferta (`offer ack … node=…`), cada `<call>` recebido com os
  campos da ação (`call: received <tipo> for <call_id> from <jid> detail=…`) e cada encerramento.
- **`logged_out` publicado com a causa**, inclusive nas quedas que o Waxum trata como passageiras:
  `{"event":"logged_out","data":{"reason":"LoggedOut","on_connect":false,"conflict":"device_removed","raw":"…"}}`.
  `conflict = "device_removed"` é o aparelho removido pelo WhatsApp; a API marca a linha
  (`LineLossService`). `stream_error` passa a levar `raw` além de `code`.
- **Log de eventos sem corte** para `incoming_call`, `logged_out`, `account_locked`,
  `stream_error`, `connected` e `disconnected` (até 4000 caracteres); os demais continuam com 160,
  para o texto das mensagens não ir para o log.
- **Encerramento**: o Waxum guarda as ligações que ele originou. O `POST …/calls/terminate` que a
  API manda no fim de cada ligação não repete um `<terminate>` que já chegou ao lead e, quando a
  ligação terminou do lado local sem avisar o lead, manda o `<terminate>` com o nosso JID como
  `call-creator` (antes ia com o do lead).
- **Codec por ligação**: `…/calls/media/ws?to=…&kind=audio&codec=opus|mlow`. Sem `codec`, vale o
  `WA_CALL_AUDIO_CODEC`. A API só manda `codec` na ligação de canário (A/B por linha, `canaryCodec`).
- **Trava por sessão**: `flock` em `{sessão}/.session.lock` enquanto o cliente roda, para dois
  Waxums nunca abrirem a mesma sessão no volume compartilhado. Outro Waxum espera até 20 s e desiste.
- **Perfil do handshake por ambiente**: `WA_CLIENT_LOCALE` (ex.: `pt_BR`) e `WA_CLIENT_OS_VERSION`.
  Sem eles, vale o perfil web da biblioteca (`en_US`, `0.1.0`). `WA_DEVICE_PLATFORM` /
  `WA_DEVICE_OS` continuam valendo só no pareamento.

A API guarda os sinais em `call_signal_events` (migração 078, `CallSignalService`), com os ms desde
a oferta (`calls.offer_sent_at`).

## Envio só pelo relay que responde (imagem `0.12.6-multirelay-v6-relay-select`)

Desde a correção do áudio mudo (`docs/postmortem-audio-unidirecional.md`), o Waxum manda cada
pacote de áudio para **todos** os relays da oferta (o principal e uns 2 extras), porque o celular
do lead escolhe o relay dele depois de atender. Isso triplica o envio. Numa linha que sai por
proxy, que é cobrada por GB, ficava em ~3 MB por minuto de ligação.

O patch `whatsapp-rust-relay-select.patch` (`RelayActivity`, `transport/native.rs`) passa a:

- mandar para todos os relays até o áudio do lead chegar e por mais 3 s depois disso;
- depois, mandar só para o relay por onde o áudio do lead chega (ele fala e escuta no mesmo);
- voltar a mandar para todos na hora em que esse relay fica 1,5 s sem trazer áudio, e
  seguir o lead se ele mudar de relay.

Os extras continuam alocados e com consentimento renovado a cada segundo, para a volta ao envio
para todos ser imediata. O log `voip: outbound media only to …` / `back to every relay` mostra
cada troca. Se aparecer áudio mudo do lado do lead, a volta é a imagem `v5-signal`.

### Envelope `0x09` (imagem `0.12.6-multirelay-v7-relay-unwrap`)

Na v6 o consumo não caiu: no dia 26/11 a vaga da proxy mandou 16,9 MB e recebeu 15,2 MB em ~11 min
de ligação, os dois sentidos ~3 vezes o normal. Os relays entregam a mídia com um envelope de
encaminhamento (`0x09 …`, `unwrap_group_forwarding_packet`), que o motor tira antes de ler. O
transporte multirelay classificava o pacote cru, e `0x09` tem os dois bits altos zerados: virava
STUN. Assim o relay do lead nunca era reconhecido (o envio continuava para todos) e os relays extras
descartavam a mídia que recebiam. A v7 tira o envelope antes de classificar
(`inbound_relay_packet_kind`).

## Identidade por linha (imagem `0.12.6-multirelay-v8-identity`)

Até a v7 a identidade vinha do ambiente do contêiner: o edge-1 registrava as linhas como Chrome e
fazia login em pt-BR, os outros como Desktop e en-US. Quando o pool trocava uma linha de PC, o login
dela mudava de idioma no meio da vida do aparelho. O patch `waxum-zapliga-identity.patch`:

- aceita `client_profile: { locale }` (e `{ reset: true }`) ao lado do `device` já existente em
  `POST /sessions`, `/sessions/{id}/connect` e `/sessions/{id}/pair`;
- grava o que a linha pediu em `{sessão}/zapliga-identity.json`, no volume compartilhado: a
  identidade acompanha a linha em toda troca de PC e em todo restart, sem depender da API;
- precedência: o pedido, o arquivo da sessão, o ambiente (`WA_DEVICE_*`, `WA_CLIENT_*`), o padrão da
  biblioteca. Sessão que nunca pediu identidade sobe exatamente como na v7;
- `WA_SESSION_IDENTITY=off` ignora os arquivos e o `client_profile` dos pedidos (o `device` do
  pedido segue valendo, como antes);
- publica `wa.events.<sessão>.call_ack`: o ack do servidor (`id`, `from`, `error`, ex.: `463`) de
  cada stanza de ligação nossa, a oferta incluída. A API grava em `call_signal_events`.

Quem decide a identidade de cada linha é a API (`docs/stealth-profile.md`). Primeiro só no edge-3:
enquanto os outros edges estiverem na v7, uma linha com a opção que for movida para eles volta ao
login do ambiente.
