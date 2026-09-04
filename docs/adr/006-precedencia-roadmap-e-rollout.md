# ADR 006 — Precedência operacional e rollout do roadmap

## Status

Aceita para implementação local. Ativação em produção continua sujeita ao runbook e
à autorização explícita.

## Contexto

Campanhas, fila inteligente e recomendações passam a sugerir ou escolher ações. O
produto já possui regras globais, agenda, supressão, callbacks e proteções de linha.
Sem uma precedência única, duas telas ou serviços poderiam tomar decisões diferentes.

## Decisão

Toda tentativa será avaliada nesta ordem:

1. autenticação, tenant e permissão;
2. status ativo da empresa e da campanha;
3. supressão, consentimento aplicável e janela permitida;
4. propriedade de callback e elegibilidade do SDR;
5. conectividade, cooldown, quarentena e rate limits da linha;
6. tetos globais da empresa;
7. configuração versionada da campanha;
8. score e desempate determinístico;
9. reserva atômica com revalidação das regras duras.

Regras dos itens 1 a 6 são guardrails: score, meta ou recomendação não podem
compensá-las. Quando configuração global e campanha divergirem, vale o limite mais
restritivo. A resposta deve registrar a origem efetiva de cada valor como
`global_default`, `campaign_override` ou `safety_cap`.

## Compatibilidade e rollout

- Todas as novas flags começam desligadas.
- Flag desligada preserva API e comportamento legado.
- Seleção nova estreia em `shadow mode`.
- Falha de decisão, analytics ou recomendação degrada para estratégia legada.
- Migrations seguem expansão e contração; rollback de comportamento usa flag, não
  remoção de schema.
- Cada decisão automática registra versão, reason codes e evidência mínima.

## Consequências

- Elegibilidade precisa ser centralizada antes da ativação do score.
- O `DialerService` mantém responsabilidade pela reserva atômica.
- Frontend não pode implementar regra operacional exclusiva.
- Recomendações revalidam estado no momento da ação.
- Observabilidade deve distinguir bloqueio de segurança de ausência de capacidade.
