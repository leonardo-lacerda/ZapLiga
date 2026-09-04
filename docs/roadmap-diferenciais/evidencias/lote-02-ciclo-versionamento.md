# Evidência — Lote 02: ciclo e versionamento de campanhas

## Resultado

O Lote 02 está implementado em uma fatia vertical: contrato de configuração,
validação pura, criação, edição, publicação, transições de estado, duplicação,
lock otimista, snapshots imutáveis, hash, diff, auditoria e wizard web.

Campanhas novas começam como `draft` sem versão publicada. A publicação cria a
versão 1; uma edição durante `running` cria a próxima versão sem reescrever o
snapshot anterior. Campanhas legadas continuam somente leitura e podem ser
duplicadas para o novo ciclo.

## Arquivos principais

- `apps/api/src/database/migrations/044_campaign_lifecycle.sql`
- `apps/api/src/modules/campaigns/campaigns.domain.ts`
- `apps/api/src/modules/campaigns/campaigns.dto.ts`
- `apps/api/src/modules/campaigns/campaigns.repository.ts`
- `apps/api/src/modules/campaigns/campaigns.service.ts`
- `apps/api/src/modules/campaigns/campaigns.controller.ts`
- `apps/web/src/features/campaigns/CampaignsPage.tsx`
- `apps/web/src/features/campaigns/CampaignsPage.spec.tsx`
- `scripts/verify-campaign-lifecycle.mjs`

## Contratos entregues

- `POST /api/tenants/:tenantId/campaigns`
- `PATCH /api/tenants/:tenantId/campaigns/:campaignId`
- `POST .../:campaignId/publish|start|pause|complete|archive|duplicate`
- `GET .../:campaignId/versions`
- `GET .../:campaignId/versions/:version`
- `GET .../:campaignId/diff?from=:version&to=:version`

Todas as mutações exigem `expectedLockVersion`; a transação relê a campanha com
`FOR UPDATE`, valida escopo de pasta/SDRs/linhas e grava auditoria no mesmo
transaction boundary.

## Verificações executadas

| Verificação | Resultado |
| --- | --- |
| `npm --workspace apps/api test -- --runInBand campaigns` | 3 suítes, 11 testes aprovados |
| `npm --workspace apps/api run typecheck` | aprovado |
| `npm --workspace apps/web test -- CampaignsPage.spec.tsx --reporter=dot` | 2 testes aprovados |
| `npm run check:structure` | aprovado |
| `npm test` | 32 suítes, 189 testes aprovados |
| `npm run test:web` | 14 arquivos, 32 testes aprovados |
| `npm run typecheck` | aprovado |
| `npm run build` | API e web compilados localmente |
| `npm run verify:campaign-migration` | legado preservado, imutabilidade e FKs cross-tenant aprovadas |
| `npm run verify:multitenant` | autenticação, IDOR, flags e isolamento aprovados |
| `npm run verify:campaign-lifecycle` | ciclo HTTP completo aprovado e tenant temporário removido |

## E2E e rollout local

O teste Playwright existente confirmou os cinco primeiros cenários de autenticação,
flags, isolamento e leitura legada. A suíte completa parou no cenário preexistente
de conexão Waxum porque a linha descartável permaneceu `waiting_for_qr`; esse
guardrail de áudio não foi removido nem relaxado. O ciclo novo foi validado
separadamente pelo script HTTP dedicado acima, usando tenant, pasta, SDR e linha
sintéticos e limpeza idempotente.

O módulo continua protegido pela flag `campaigns`, desligada por padrão. Nenhuma
ação de produção, push ou deploy foi executada.
