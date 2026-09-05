# Evidência do Lote 12 — aprendizado por tenant em modo shadow

## Resultado

O ZapLiga agora calcula sinais históricos explicáveis por tenant, com amostra
mínima, suavização, período reproduzível e gate de confiabilidade. A operação
recebe insights descritivos e um monitor de estabilidade/concentração; nenhum
sinal histórico entra na decisão ativa.

## Entregas verificadas

- A migration `051_analytics_tenant_learning.sql` cria snapshots e runs
  tenant-scoped, preservando período, timezone, versão da fórmula, amostra,
  métricas brutas, métricas suavizadas, confiança e confiabilidade analítica.
- O rebuild agrega tenant, dia/hora local, campanha, origem sanitizada,
  recência, tentativa, estágio e linha. O período padrão é lido do último run
  persistido, evitando intervalos diferentes entre rebuild, insights e UI.
- A fórmula v1 usa suavização `(sucesso + 1) / (chamadas + 2)` para atendimento,
  resultado positivo e falha. Sinais abaixo de 20 chamadas são
  `insufficient_data`; entre 20 e 39 são direcionais; a UI sempre informa
  amostra, denominador, período e confiança.
- O motor passa `historicalBoost` somente no `DecisionShadowService`. O caminho
  ativo continua determinístico e não consome o sinal histórico.
- O endpoint de monitoramento compara falha por linha com o baseline do tenant
  e alerta concentração por origem ou tentativas posteriores. O texto deixa
  explícito que concentração observada não prova causalidade.
- A tela Aprendizado da operação é protegida pela flag `analytics_learning` e
  mostra o guardrail de shadow, melhores janelas, insights e alertas de qualidade.

## Critérios do lote

- [x] Sinal sem amostra mínima não influencia a decisão ativa.
- [x] Todo insight elegível mostra período, denominador e confiança.
- [x] Confiabilidade abaixo do mínimo bloqueia insights e sinais históricos.
- [x] Estabilidade por linha e concentração da amostra ficam observáveis.
- [x] Isolamento por tenant é aplicado em rotas, queries, snapshots e runs.

## Validação local

Executado no stack descartável `zapliga-roadmap-e2e`, sem alteração em
produção:

- `npm run typecheck`
- `npm run test:web` — 16 arquivos / 36 testes
- build local das imagens `api-a` e `api-b`
- health checks dos dois processos da API após restart local
- `npm run verify:analytics-learning` — cobertura 40/40, 47 snapshots,
  3 insights, confiabilidade `reliable`, estabilidade `stable` e monitor de
  seleção `attention` para o fixture intencionalmente concentrado
- migration 051 aplicada no Postgres local
- limpeza tenant-scoped confirmada: nenhum tenant `learning-*` permaneceu

## Próxima etapa

O Lote 12 está concluído localmente. O próximo lote implementa experimentos
controlados com atribuição estável, guardrails, parada imediata e relatório de
incerteza.
