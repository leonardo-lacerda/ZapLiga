# Imagem do Waxum usada pelo ZapLiga

O serviço `waxum` do `docker-compose.yml` **não** roda a imagem publicada
`fdciabdul/waxum`. Roda `zapliga-waxum:<tag>`, uma imagem construída por nós a
partir do Waxum `v0.12.5` com a biblioteca `whatsapp-rust` trocada por um
snapshot corrigido. Sem essas correções as chamadas de saída ficam
unidirecionais (o lead ouve o SDR, o SDR não ouve o lead). O histórico completo
está em [`docs/postmortem-audio-unidirecional.md`](../../docs/postmortem-audio-unidirecional.md).

## O que há aqui

| Arquivo | Para quê |
|---|---|
| `build.sh` | Reconstrói a imagem do zero numa máquina limpa: baixa os upstreams pinados, aplica os patches, corrige CRLF e roda `docker build`. |
| `patches/whatsapp-rust-zapliga.patch` | Nossas mudanças sobre `oxidezap/whatsapp-rust @ 9be10573` (main de 2026-09-01). |
| `patches/waxum-zapliga.patch` | Nossas mudanças sobre `imtaqin/waxum v0.12.5` (`Cargo.toml` com `[patch]` apontando para `./whatsapp-rust`, `Cargo.lock`, `Dockerfile`, `docker-entrypoint.sh` em LF, compat em `src/handlers/mex.rs`). |
| `entrypoint-guard.sh`, `healthcheck.sh` | Montados no container pelo compose (espera NATS; healthcheck exige a conexão Rust no NATS). |

## O que os patches corrigem (whatsapp-rust)

1. **Bind em todos os relays de mídia** (`wacore/src/voip/relay_parse.rs::get_usable_relay_endpoints`,
   `src/voip/transport/native.rs::MultiRelayMediaChannelFactory`, `src/voip/facade.rs::relay_extras_from_data`).
   Quem atende elege o próprio relay depois do accept e pode migrar a mídia para
   outro host da oferta; conectando em um só, o downlink nunca chegava. Agora
   alocamos em todos (cada um com o próprio token), fazemos broadcast do uplink e
   mesclamos o downlink de qualquer um — como o cliente oficial.
2. Preferência de relay na porta web-client / FNA para o endpoint primário
   (`get_media_relay_endpoint`) e telemetria dos candidatos (`voip: outgoing relay candidates`).
   Quando a oferta anuncia apenas `3478`, a conexão em `3480` recebe 2 s de
   vantagem antes do fallback: `3478` pode completar o handshake e aceitar o
   uplink sem encaminhar o áudio do telefone de volta.
3. Chamada multi-device: um companion que rejeita com `reason=enc` não derruba a
   chamada enquanto o telefone principal ainda toca (`src/handlers/call.rs`,
   `wacore/src/stanza/call.rs`).

## Como reconstruir

```bash
# na sua maquina (nunca na VPS):
infra/waxum/build.sh 0.12.6-multirelay-v3
docker save zapliga-waxum:0.12.6-multirelay-v3 | gzip \
  | ssh -i ~/.ssh/zapliga_actions root@209.50.229.249 'gunzip | docker load'
```

Depois, na VPS, a troca controlada é a do runbook (`docs/deploy-runbook.md`,
seção "Imagem do Waxum"): `docker tag` da atual como `:rollback`, ajustar
`image:` no `docker-compose.yml`, `docker compose up -d --no-deps --no-build waxum`
e **commitar** a mudança do compose — o deploy automático aplica o compose do
repositório e recusa qualquer `*.override.yml` no host.

## Como validar uma imagem nova

1. `docker compose ps waxum` mostra a tag esperada e `healthy`.
2. Uma chamada real atendida, com a pessoa falando, e no log do discador
   ("Diagnóstico de reprodução") `cliente→servidor pico > 0`.
3. Nenhum `AudioReceptionStalled` no log do Waxum para essa chamada.

Se `pico=0` voltar: é o servidor/relay, não o headset — ver §8 do postmortem.

## Como atualizar os upstreams

1. Ajuste `WAXUM_REF` / `WHATSAPP_RUST_REF` no `build.sh`.
2. Monte a árvore com o script até o passo dos patches; resolva rejeições.
3. Regenere os patches:
   `diff -ruN --exclude=target --exclude=.git <upstream> <corrigido> > patches/<nome>.patch`
4. Rode a suíte do `whatsapp-rust` com as features de produção antes de buildar:
   `cargo test -p whatsapp-rust --features voip,tracing voip`
   (a partir de `whatsapp-rust/`; o teste pré-existente
   `web_client_port_is_judged_by_the_dialed_ipv4_address` falha no upstream —
   ver pendências no postmortem).
5. Build, ship, validar com chamada real, commitar compose + este README.

Idealmente, leve a correção multi-relay para o upstream
([oxidezap/whatsapp-rust#1098](https://github.com/oxidezap/whatsapp-rust/issues/1098))
e encurte este patch.
