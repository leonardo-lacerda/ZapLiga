# Evidência do Lote 08 — ações recomendadas seguras

## Resultado

O endpoint `apply` deixou de ser apenas uma confirmação de navegação e passou a
executar exclusivamente ações que pertencem ao catálogo fechado. Os tipos suportados
são navegação, pausa de campanha, início do discador, proteção temporária de linha e
reatribuição de callbacks.

Antes de executar, o backend consulta novamente o estado dentro do tenant. Campanhas
usam lock de linha e só podem ser pausadas quando estão rodando; o discador verifica
a agenda; uma linha com chamada ativa não pode ser protegida; callbacks só podem ser
reatribuídos a SDR ativo do mesmo tenant. Payloads enviados pelo cliente não escolhem
método, tabela ou query: a ação e o payload são os que já estavam persistidos na
recomendação catalogada.

As mutações registram auditoria e o evento da recomendação contém ação, estado antes,
estado depois e resultado. Falhas também geram evento `failed`. Após sucesso a
recomendação é marcada como resolvida, impedindo uma segunda aplicação; operações que
já estavam no estado desejado retornam `no_op` sem duplicar efeito.

## Validação executada

- Teste unitário de idempotência do discador e bloqueio de ação arbitrária — 2 testes
  aprovados.
- `npm run verify:recommendations` — ação `start_dialer` aplicada uma vez, segunda
  tentativa bloqueada com `409`, histórico e cleanup aprovados.
- `npm run verify:multitenant` — tenant explícito, IDOR e novas tabelas aprovados.
- `npm run check:structure` — aprovado.
- `npm run typecheck` — aprovado.
- `npm test -- --runInBand` — 38 suítes, 212 testes aprovados.
- `npm run test:web` — 14 arquivos, 34 testes aprovados.
- Build local de API/web e health das duas APIs — aprovados.

O Lote 09 será responsável por ampliar as recomendações com telemetria e score de
saúde, preservando a separação entre diagnóstico e ação.

