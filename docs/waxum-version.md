# Versão do Waxum

## Versão validada

- Versão: `0.12.4`
- Imagem: `fdciabdul/waxum:0.12.4`
- Digest do manifesto multi-arquitetura: `sha256:056342ba0f4d269563057573d796de848df8e3b52043463f344bd68065227e18`
- Digest Linux/amd64: `sha256:7a2c551b83b7eb0d7cd92a76d9f76f82a2888228c2993ef8a04e4e842ec3a576`
- Validada em: `2026-08-30`

## Build usado pelo ZapLiga

- Commit oficial: `4cfb4e44983e5381667396799bd0e6442a32c4c4` (`v0.12.4`)
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
