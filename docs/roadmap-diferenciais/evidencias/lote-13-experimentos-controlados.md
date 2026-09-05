# Evidência — Lote 13: experimentos controlados

## Status

Concluído localmente em 2026-09-04, sem Docker.

## Entregas verificadas

- Migration `052_experiments_and_assignments.sql` com experimentos, variantes,
  guardrails, atribuições estáveis, avaliações e vínculo da chamada com a
  variante.
- API tenant-scoped para criar, listar, iniciar, pausar, parar, avaliar
  guardrails, atribuir lead e gerar relatório.
- Hipótese, métrica primária, alocação de variantes e os quatro guardrails
  obrigatórios são validados antes do início.
- Atribuição determinística por SHA-256 de tenant, experimento e lead, com
  persistência e releitura após conflito concorrente.
- O discador atribui antes da reserva automática, grava experimento/variante na
  chamada, aplica a cadência da variante no retry e reavalia guardrails ao
  encerrar chamadas.
- Parada operacional imediata por guardrail ou ação explícita do operador.
- Relatório descritivo por variante com denominador, amostra, diferença
  observada e intervalo de Wilson de 95%; não há vencedor automático nem
  linguagem de causalidade indevida.
- UI opt-in em `/app/experimentos`, inicialmente limitada a cadência e
  prioridade, com ciclo de vida e leitura do relatório.

## Gates Q1–Q7

- **Q1 — isolamento:** consultas, atribuições, chamadas e rotas exigem
  `tenant_id`.
- **Q2 — legado seguro:** a flag `experiments` inicia desligada; o discador
  retorna ao caminho normal quando ela está desligada.
- **Q3 — definição completa:** experimentos incompletos não iniciam e não há
  troca de variante depois da atribuição.
- **Q4 — guardrails:** falha, opt-out, queda rápida e falha de linha exigem
  amostra mínima de 20 e podem interromper o experimento.
- **Q5 — parada:** o operador pode parar imediatamente e cada encerramento de
  chamada dispara nova avaliação do experimento da campanha.
- **Q6 — incerteza:** relatório expõe numerador, denominador e IC 95%, sem
  transformar sinal de baixa amostra em decisão.
- **Q7 — comunicação:** a interpretação declara explicitamente que o resultado
  é descritivo e não afirma causalidade fora do desenho.

## Validação local

```text
npm run check:structure       PASS
npm run typecheck             PASS
npm test                      PASS — 44 suítes, 231 testes
npm run test:web              PASS — 17 arquivos, 37 testes
```

O teste de navegador/E2E não foi iniciado nesta rodada para respeitar a decisão
de manter o desenvolvimento sem Docker. A validação de integração com um banco
local deve ser executada quando essa infraestrutura estiver disponível; ela não
foi apresentada como evidência de produção.

