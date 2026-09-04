# Matriz de compatibilidade das feature flags

## Regra geral

Todas as flags novas retornam `false` para tenants existentes, linhas antigas no
Redis e empresas criadas após a migration. Ativar uma camada não autoriza ativar
automaticamente suas dependências.

| Flag | Desligada | Ligada | Dependências para uso ativo | Fallback |
| --- | --- | --- | --- | --- |
| `campaigns` | pastas e discador atuais | campanhas ficam acessíveis | nenhuma para leitura | fluxo legado |
| `decision_engine` | FIFO/LIFO/prioridade atual | sombra ou score por campanha | `campaigns` | estratégia anterior |
| `recommendations` | alertas atuais | central unificada | nenhuma para regras básicas | alertas atuais |
| `operation_health` | status atuais de linha | score e timeline | telemetria válida | status atuais |
| `analytics_learning` | métricas atuais | sinais históricos em sombra | campanhas e qualidade de dados | sinais ignorados |
| `experiments` | nenhuma alocação | experimentos controlados | decisão e analytics | política padrão |
| `benchmarks` | nenhum dado compartilhado/exibido | coortes elegíveis | opt-in, jurídico, amostra | benchmark oculto |

## Combinações obrigatórias nos testes

1. Todas desligadas: comportamento atual sem alteração.
2. `campaigns` ligada isoladamente: leitura e configuração sem fila inteligente.
3. `decision_engine` em sombra: nenhuma alteração na ordem real.
4. Recomendações ligadas sem saúde: somente regras com evidência disponível.
5. Saúde ligada sem analytics: score operacional sem sinais históricos.
6. Analytics indisponível: chamadas continuam e sinais históricos são ignorados.
7. Benchmarks ligados sem consentimento/amostra: resposta bloqueada ou indisponível.

## Administração

Somente `super_admin` pode alterar flags pelo endpoint tenant-scoped. Toda alteração
é auditada, invalida o cache Redis e informa exatamente quais chaves mudaram.
