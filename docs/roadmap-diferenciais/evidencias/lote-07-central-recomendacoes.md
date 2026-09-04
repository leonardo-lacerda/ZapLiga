# Evidência do Lote 07 — catálogo e central de recomendações

## Resultado

Foi criado um catálogo determinístico que transforma os alertas existentes em
recomendações tenant-scoped, ordenadas por severidade e limitadas a três prioridades.
Cada item possui código estável, título, evidência estruturada com origem e horário,
ação catalogada, versão da regra, fingerprint e estado persistido.

A central de comando do dashboard é habilitada por `recommendations`. Com a flag
desligada, a atenção legada permanece intacta. Com a flag ligada, a UI consulta a
API e oferece evidência, abrir detalhes, lembrar depois e dispensar. Ações
operacionais mutáveis permanecem bloqueadas até o Lote 08; no Lote 07 o CTA seguro é
de navegação e a interação fica registrada.

## Backend e dados

- Migration `047_operation_recommendations.sql` com recomendações, eventos,
  constraints tenant-scoped e índices de status/expiração.
- Fingerprint impede que um mesmo problema resolvido seja reaberto sem mudança de
  evidência.
- Condições que deixam de existir são marcadas como `resolved` durante a atualização.
- Eventos suportados: impressão, abertura, adiamento, dispensa, aplicação, falha e
  resolução.
- Rotas protegidas por autenticação, membership, papel de líder/super admin e flag.

## Validação executada

- Catálogo puro: 1 teste direcionado aprovado.
- Dashboard: 2 testes direcionados aprovados; o caminho legado continua coberto.
- `npm run verify:recommendations` — flag desligada, ativação, limite de três,
  evidência sem segredo e histórico de abertura/adiamento aprovados.
- `npm run verify:multitenant` — isolamento tenant-scoped aprovado após incluir as
  novas tabelas no cleanup do smoke.
- Migration aplicada no banco descartável local; status sem pendências inesperadas.
- Build e health das APIs locais aprovados.

O Lote 08 será responsável por executar ações operacionais com revalidação,
idempotência e confirmação proporcional ao impacto.

