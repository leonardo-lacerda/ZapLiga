# Versão do Waxum

## Versão validada

- Versão: `0.12.6`
- Imagem: `fdciabdul/waxum:0.12.6`
- Digest do manifesto multi-arquitetura: `sha256:7682a3f3c93eac2e5b5a0e2263b38d0d718f0033a8b976c6b04c0481d06a100b`
- Digest Linux/amd64: `sha256:5367a77988c7b2a504b8826d9fc355f7361c0009e7e92850ad95a888ae42d98b`
- Validada em: `2026-09-01`

## Build usado pelo ZapLiga

- Commit oficial: `e835160d3f9348dcf7cb99fb2a99c8a18ea4d2ec` (`v0.12.6`)
- Imagem oficial fixada pelo digest do manifesto acima.
- Sem fork ou patch local do Waxum.
- Middleware global de rate limit do Waxum desativado explicitamente com
  `RATE_LIMIT_ENABLED=false`; o controle de cadência fica no ZapLiga.

O endpoint de diagnóstico `events/tail` do Waxum limita o payload a 160 caracteres e não deve ser usado para detectar atendimento. O ZapLiga consome o evento completo `wa.events.<session_id>.incoming_call` publicado pelo Waxum no NATS JetStream e correlaciona o `call_id` e a ação `Accept`.

Essa é a versão usada e testada pelo ZapLiga. O digest no `docker-compose.yml` impede atualizações silenciosas da imagem.

## Regra de atualização

Não trocar a versão automaticamente. Qualquer atualização deve:

1. validar QR Code, conexão da sessão, chamada manual e discador;
2. testar áudio bidirecional e encerramento;
3. confirmar limites, cooldown, retry e liberação dos locks;
4. atualizar este arquivo e o digest fixado no `docker-compose.yml` no mesmo commit.

Fonte: [repositório oficial do Waxum](https://github.com/imtaqin/waxum).
