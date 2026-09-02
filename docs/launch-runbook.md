# Runbook de lançamento e suporte

## Pré-Gate B

1. Jurídico aprova versões vigentes de Termos, Privacidade e ADR 005.
2. Configurar Resend, `DATA_PROTECTION_SECRET`, `METRICS_TOKEN`, Sentry sanitizado e coleta de `/internal/metrics` com Bearer token.
3. Importar `infra/monitoring/grafana-zapliga-dashboard.json` e `prometheus-alerts.yml`.
4. Manter `PUBLIC_REGISTRATION_ENABLED=false`.
5. Confirmar CI verde: tipos, 165+ testes API, testes frontend, build e 12 E2E.
6. Executar `npm run verify:multitenant` contra staging.
7. Usar dois tenants piloto e uma linha/contato de teste com autorização escrita.

## Smoke real do Waxum em staging

Use apenas número corporativo e destinatário autorizados. Conecte a linha, confira status, abra o canal do SDR, faça uma chamada manual, valide áudio nos dois sentidos, encerre e registre pós-atendimento. Depois valide cooldown, ausência de chamada ativa e log/auditoria. Não use contatos reais de clientes no smoke.

## Rollout

1. Migrations são aplicadas antes da interface e nunca revertidas.
2. Habilitar flags em uma empresa interna, observar 24 h; depois duas pilotos, observar 48 h; então todas.
3. Rollback: um super admin desliga `onboarding`, `callbacks`, `privacy_requests` ou `schedule_enforcement` via `PATCH /api/tenants/:tenantId/feature-flags`. Supressão não possui bypass e líderes não controlam flags.
4. Cadastro público só é ligado após aprovação formal do Gate B.

## Incidente

Classifique P0 (contato suprimido chamado, vazamento multitenant, acesso revogado válido) ou P1 (conta/callback/LGPD indisponível). Pare novas chamadas, preserve auditoria, desligue somente a flag afetada, registre janela/tenants/build e comunique responsáveis. Nunca copie telefone, e-mail, token ou notas para chat de incidente. Para P0, manter cadastro e discador pausados até correção e teste de regressão.

## Solicitação LGPD

Líder busca o titular por telefone, cria a solicitação, confirma identidade por processo externo aprovado, processa exportação/correção/anonimização e registra a conclusão. O download expira em 24 h. Em falha, o alerta `ZapLigaPrivacyJobFailure` exige triagem; repetir é seguro porque o job é idempotente. Não remover a supressão mínima sem decisão do DPO.

## Suporte assistido e cobrança

Comercial solicita criação/limites; super admin executa e a auditoria registra; Financeiro confirma situação contratual. Bloqueio ou arquivamento deve ser comunicado antes e revoga sessões. Mudança para checkout self-service exige executar a Fase 8 e o Gate C.
