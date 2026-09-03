# Plano 02 — Motor de decisão e fila inteligente

## Resultado desejado

Fazer o ZapLiga selecionar a próxima tentativa com base em prioridade comercial,
probabilidade operacional e risco, sempre mostrando por que o lead foi escolhido ou
bloqueado.

## Base existente

O projeto já possui `queue_priority`, `queue_sequence`, estratégia
`priority_fifo`, horários permitidos, limite de tentativas, cooldown, quarentena,
callbacks e locks distribuídos. O primeiro incremento deve usar esses mecanismos,
sem introduzir aprendizado de máquina no caminho crítico.

## Princípio de decisão

O motor avalia candidatos em duas etapas:

1. **Elegibilidade:** regras duras que permitem ou proíbem a chamada.
2. **Ordenação:** score que define qual candidato elegível deve vir primeiro.

Uma pontuação alta jamais ignora supressão, agenda, limite, callback pertencente a
outro SDR ou proteção da linha.

## Escopo do MVP

- Score determinístico de 0 a 1000 para leads elegíveis.
- Motivos estruturados que explicam componentes positivos e negativos.
- Políticas de score versionadas por campanha.
- `shadow mode` que calcula sem mudar a ordem real.
- Comparação entre FIFO atual e ordem recomendada.
- Ativação gradual por tenant e campanha.
- Registro da decisão efetiva em cada tentativa.

## Modelo de dados

### Migration proposta: `043_decision_engine.sql`

Criar `decision_policies`:

- `id`, `tenant_id`, `campaign_id`, `version`, `status`;
- pesos e limites em JSON validado;
- autor, justificativa, timestamps e hash.

Criar `call_decisions`:

- `id`, `tenant_id`, `campaign_id`, `lead_id`, `call_id` opcional;
- `policy_id`, `policy_version`, `mode` (`shadow` ou `active`);
- `score`, `reason_codes`, `feature_snapshot` minimizado;
- posição FIFO, posição sugerida, decisão final e timestamp.

Evitar persistir nome ou telefone no snapshot. IDs e atributos necessários à
explicação são suficientes.

## Features iniciais do score

| Componente | Exemplo | Natureza |
| --- | --- | --- |
| prioridade de origem | lead inbound recente | configurável |
| idade do lead | tempo desde recebimento | configurável |
| callback vencendo | horário solicitado pelo lead | prioridade forte |
| tentativas anteriores | penalidade progressiva | configurável |
| intervalo desde tentativa | respeita cadência | elegibilidade + score |
| desempenho por faixa horária | histórico do tenant | somente após amostra mínima |
| qualidade da origem | resultado histórico da campanha | somente após amostra mínima |
| fairness entre pastas/campanhas | evita fome de fila | proteção sistêmica |

Não usar características sensíveis nem inferências sobre raça, saúde, religião,
renda ou outros atributos sem necessidade legítima e revisão jurídica.

## Contrato de explicação

Cada avaliação retorna:

```json
{
  "eligible": true,
  "score": 730,
  "policyVersion": 3,
  "reasons": [
    { "code": "recent_inbound", "effect": 180 },
    { "code": "callback_due", "effect": 300 },
    { "code": "previous_attempts", "effect": -50 }
  ],
  "constraints": ["within_schedule", "not_suppressed", "attempt_budget_ok"]
}
```

Textos humanos são derivados de códigos conhecidos no frontend. Não armazenar texto
livre gerado como única explicação.

## Backend

Criar `apps/api/src/modules/decision-engine/`:

- `eligibility.service.ts` para regras duras;
- `scoring.service.ts` como função pura e versionada;
- `decision-policy.service.ts`;
- `decision.repository.ts`;
- `decision-shadow.service.ts` para comparação assíncrona.

Endpoints:

```text
GET   /api/tenants/:tenantId/campaigns/:campaignId/decision-policy
PUT   /api/tenants/:tenantId/campaigns/:campaignId/decision-policy
POST  /api/tenants/:tenantId/campaigns/:campaignId/decision-policy/simulate
GET   /api/tenants/:tenantId/campaigns/:campaignId/decision-comparison
POST  /api/tenants/:tenantId/campaigns/:campaignId/decision-mode
GET   /api/tenants/:tenantId/leads/:leadId/decision
```

O `DialerService` continua responsável pela reserva atômica. O motor apenas devolve
uma lista ordenada e evidências; a transação de reserva revalida elegibilidade.

## Shadow mode

No modo sombra, cada ciclo registra:

- candidato escolhido pela estratégia vigente;
- candidato sugerido pelo novo motor;
- diferença de posição;
- resultado posterior de ambos quando observável;
- latência e falhas de avaliação.

Não afirmar ganho causal comparando candidatos que não receberam a mesma exposição.
O modo sombra valida segurança, estabilidade e distribuição; testes controlados
validam impacto comercial.

## Frontend

- Seção `Fila inteligente` dentro da campanha.
- Simulador com os próximos candidatos e motivos.
- Comparação visual `ordem atual` versus `ordem sugerida`.
- Drawer “Por que este lead?” na fila e no histórico da chamada.
- Controle explícito de modo: desligado, sombra, ativo.
- Aviso de amostra insuficiente para componentes históricos.

## Fases

### Fase 1 — elegibilidade unificada

- Extrair regras hoje espalhadas no discador para um contrato testável.
- Garantir paridade com o comportamento existente.

### Fase 2 — score determinístico

- Política padrão conservadora.
- Simulação e explicações.

### Fase 3 — sombra

- Registrar comparações sem alterar chamadas.
- Verificar latência, fairness e distribuição por pasta/campanha.

### Fase 4 — ativação controlada

- Habilitar por campanha.
- Kill switch imediato para retornar a `priority_fifo` ou `fifo`.

### Fase 5 — sinais históricos

- Usar desempenho por horário e origem apenas após os critérios do Plano 05.

## Critérios de aceite

- [ ] Para toda decisão existe política, versão, score e motivos consultáveis.
- [ ] Leads suprimidos ou fora de agenda nunca aparecem como elegíveis.
- [ ] A reserva revalida regras dentro da transação.
- [ ] Falha do motor retorna com segurança à estratégia configurada.
- [ ] O modo sombra não altera ordem, estado ou quantidade de chamadas.
- [ ] Nenhuma campanha fica sem capacidade indefinidamente por causa do score.
- [ ] O p95 de avaliação cabe no orçamento do ciclo do discador.
- [ ] Testes cobrem empate, starvation, callback, supressão e concorrência.

## Métricas

- diferença média de posição entre FIFO e score;
- tempo do lead até primeira tentativa;
- taxa de atendimento e resultado por faixa de score;
- fairness entre campanhas e pastas;
- taxa de fallback;
- latência p50/p95/p99;
- decisões bloqueadas por cada regra dura.

## Riscos

- Viés de seleção pode fazer correlação parecer causal.
- Score complexo demais destrói confiança; limitar componentes e mostrar motivos.
- Consulta pesada pode atrasar o tick; pré-calcular sinais históricos e limitar
  candidatos por lote.
- Um peso mal configurado pode concentrar chamadas; validar limites no backend.
