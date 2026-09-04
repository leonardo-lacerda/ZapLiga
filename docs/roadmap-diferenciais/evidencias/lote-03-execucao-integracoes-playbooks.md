# Evidência — Lote 03: execução por campanha, integrações e playbooks

## Resultado

O Lote 03 está implementado em uma fatia vertical: campanhas agora resolvem uma
configuração efetiva por lead, integrações de entrada preservam campanha e versão,
e o discador grava o contexto efetivamente usado na reserva e no resultado da
chamada. A implementação mantém compatibilidade com leads legados sem campanha e
usa limites globais como teto de segurança.

## Entregas principais

- Migration `045_campaign_execution.sql` com referências tenant-safe para
  `leads`, `calls` e `lead_integrations`.
- `CampaignExecutionService` com resolução determinística de campanha, versão,
  agenda local, pools de SDR/linha e caps globais de cadência.
- Revalidação transacional na reserva da chamada, incluindo status, agenda,
  recursos, tentativas e versão efetiva.
- Associação de integrações a campanhas, atribuição da versão publicada na
  ingestão e evento idempotente `lead.received`.
- Outbox tenant-scoped para eventos de ciclo, integração e chamada, sem depender
  de entrega externa síncrona.
- Playbooks com snapshot e hash, criação/listagem e instanciação como nova
  campanha.
- UI de campanhas com ação “Salvar como playbook” e UI de integrações com seleção
  da campanha de destino.

## Garantias de segurança

- FKs compostas e consultas com `tenant_id` impedem referências cruzadas entre
  empresas.
- Uma chamada já reservada mantém `campaign_id` e `campaign_version`, mesmo que a
  campanha seja editada depois.
- A resolução retorna ao fluxo legado quando não existe campanha vinculada; uma
  campanha inválida não é usada silenciosamente.
- A cadência da campanha nunca ultrapassa `max_attempts`, `calls_per_minute` e
  `min_seconds_between_calls` globais.
- Eventos usam chave de idempotência por tenant e são gravados dentro da mesma
  transação do fato de negócio quando o fluxo já está transacional.

## Verificações executadas

| Verificação | Resultado |
| --- | --- |
| `npm run typecheck` | aprovado |
| `npm test -- --runInBand` | 33 suítes, 194 testes aprovados |
| `npm run test:web` | 14 arquivos, 32 testes aprovados |
| `npm run build` | API A, API B e web compilados no stack local |
| `npm run verify:campaign-migration` | migration, legado e FKs tenant-safe aprovados |
| `npm run verify:campaign-lifecycle` | ciclo HTTP de campanha aprovado |
| `npm run verify:campaign-execution` | ingestão → campanha → playbook e outbox aprovados |
| `npm run verify:multitenant` | isolamento, autenticação, IDOR e flags aprovados |
| healthchecks locais em `:3000` e `:3001` | saudáveis |

O stack usado foi o projeto Compose descartável `zapliga-roadmap-e2e`. Nenhum
push, deploy, restart ou alteração em produção foi executado.
