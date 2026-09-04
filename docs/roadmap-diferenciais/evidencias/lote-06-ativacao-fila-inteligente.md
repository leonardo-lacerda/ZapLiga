# Evidência do Lote 06 — ativação da fila inteligente

## Resultado

O motor de decisão agora pode ser ativado por campanha com três estados explícitos:

- `disabled`: mantém a estratégia configurada;
- `shadow`: calcula e registra a sugestão sem alterar a ordem;
- `active`: ordena candidatos elegíveis dentro dos slots de cada campanha.

A ordenação ativa é determinística por score, prioridade, elegibilidade temporal,
sequência FIFO e ID. Leads que aguardam há pelo menos 24 horas recebem proteção
contra starvation; a idade também gera um fairness boost progressivo antes desse
limiar. A reserva atômica continua no `DialerService` e a decisão ativa é registrada
somente depois que a chamada foi reservada.

## Guardrails

- Falha na avaliação de uma campanha preserva a ordem original e incrementa o
  contador de fallback.
- A flag global `decision_engine` continua desligada por padrão.
- O modo por campanha funciona como kill switch imediato, sem migration reversa:
  `active → disabled` retorna à estratégia anterior.
- O snapshot da decisão usa IDs, atributos numéricos e reason codes; não grava nome
  nem telefone do lead.
- A interface permite alternar desligado/sombra/ativo e mostra a versão da política,
  o score, os motivos e a posição sugerida.

## Observabilidade

O serviço registra contadores Redis para avaliações ativas, decisões persistidas,
fallbacks e starvation guard, além de latência de avaliação. A comparação da API
expõe delta médio de posição, distribuição por decisão, leads distintos e percentis
`p50/p95/p99`.

## Validação executada

- `npm run check:structure` — aprovado.
- `npm run typecheck` — aprovado.
- `npm test -- --runInBand` — 36 suítes, 208 testes aprovados.
- `npm run test:web` — 14 arquivos, 33 testes aprovados.
- Testes direcionados de score/política — 8 testes aprovados.
- Teste direcionado de `CampaignsPage` — 3 testes aprovados.
- Build das imagens locais API/web — aprovado; Rust/Waxum não foi compilado na VPS.
- Health local das duas APIs: banco, Redis e Waxum saudáveis.
- `npm run verify:campaign-execution` — política, simulação, sombra, ativo,
  desativação e retorno à sombra aprovados.
- `npm run verify:multitenant` — autenticação, IDOR e tenant explícito aprovados.

Nenhum deploy, push, restart de produção ou alteração em produção foi executado.

