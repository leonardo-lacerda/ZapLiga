# Versão do Waxum

## Versão validada

- Versão: `0.12.2`
- Imagem: `fdciabdul/waxum:0.12.2`
- Digest do manifesto multi-arquitetura: `sha256:b939815637dc8f382504083fcc83b8b8e66577adfd6e0aee60025feac548122b`
- Digest Linux/amd64: `sha256:57e75022185d2950e52d370b77f597ad2a533792a17df49925370bad5f121e19`
- Validada em: `2026-08-27`

## Build usado pelo ZapLiga

- Commit oficial: `1d1b6ba6a1280878ac51677a2f0e4c30dcec9d2e` (`v0.12.2`)
- Imagem oficial fixada pelo digest do manifesto acima.
- Sem fork ou patch local do Waxum.

O endpoint de diagnóstico `events/tail` do Waxum limita o payload a 160 caracteres e não deve ser usado para detectar atendimento. O ZapLiga consome o evento completo `wa.events.<session_id>.incoming_call` publicado pelo Waxum no NATS JetStream e correlaciona o `call_id` e a ação `Accept`.

Essa é a versão usada e testada pelo ZapLiga. O digest no `docker-compose.yml` impede atualizações silenciosas da imagem.

## Regra de atualização

Não trocar a versão automaticamente. Qualquer atualização deve:

1. validar QR Code, conexão da sessão, chamada manual e discador;
2. testar áudio bidirecional e encerramento;
3. confirmar limites, cooldown, retry e liberação dos locks;
4. atualizar este arquivo e o digest fixado no `docker-compose.yml` no mesmo commit.

Fonte: [repositório oficial do Waxum](https://github.com/imtaqin/waxum).
