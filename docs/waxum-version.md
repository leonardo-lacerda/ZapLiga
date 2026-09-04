# Versão do Waxum

## Versão em produção

- Imagem: `zapliga-waxum:0.12.6-multirelay-v1` (construída por nós — **não** é a `fdciabdul/waxum`)
- Base Waxum: `imtaqin/waxum` `v0.12.5` (`c673e9867216d3448339db90a0b16509a567dae1`)
- Base whatsapp-rust: `oxidezap/whatsapp-rust` `9be10573aa47bc8dcae42918c553250879383d67` (main, 2026-09-01)
- Patches e build reproduzível: [`infra/waxum/`](../infra/waxum/README.md)
- Validada em produção: `2026-09-04` (chamada real, `cliente→servidor pico>0`, sem `AudioReceptionStalled`)
- Rollback disponível no host: `zapliga-waxum:0.12.6-rollback`

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
