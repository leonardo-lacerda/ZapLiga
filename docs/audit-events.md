# Catálogo de eventos de auditoria do lançamento

| Evento | Entidade | Quando |
| --- | --- | --- |
| `contact.suppressed` / `contact.suppression_lifted` | lead/suppression | inclusão ou retirada da lista de não contato |
| `dialer.schedule_changed` / `dialer.settings_changed` | dialer | alteração da política operacional |
| `auth.password_reset_requested` / `auth.password_reset_completed` | user | recuperação de senha |
| `auth.email_verified` / `legal.documents_accepted` | user | verificação e aceite legal |
| `auth.session_revoked` / `auth.logout_all` | session/user | revogação de acesso |
| `callback.rescheduled` / `callback.reassigned` / `callback.completed` / `callback.cancelled` | callback | ciclo de retorno |
| `invitation.created` / `invitation.resent` / `invitation.accepted` / `invitation.revoked` | invitation | ciclo do convite |
| `tenant.feature_flags_updated` | tenant | rollout ou rollback por empresa |
| `privacy.request_created` / `privacy.request_completed` / `privacy.request_rejected` | data_subject_request | solicitação LGPD |
| `privacy.export_downloaded` | data_subject_request | acesso a exportação temporária |
| `provisioning.started` | provisioning_job | cadastro de WhatsApp iniciado num cloud phone GeeLark (metadados: app, id do PC de saída, vaga `edge-N` usada, id do cloud phone) |
| `provisioning.sms_submitted` | provisioning_job | código SMS repassado ao worker (o código nunca é registrado) |
| `provisioning.registered` | provisioning_job | número registrado no WhatsApp, aguardando a decisão de conectar ao ZapLiga |
| `provisioning.linked` | provisioning_job | linha criada e pareada por código, sessão Waxum `connected` (metadados: numberId). O pedido do código fica em `number.pair_code_requested` e a ida da linha para o PC do cadastro em `number.waxum_node_changed`, ambos registrados pelo módulo de números |
| `provisioning.failed` | provisioning_job | cadastro falhou (metadados: errorCode, step) |
| `provisioning.cancelled` | provisioning_job | cadastro cancelado |
| `provisioning.egress_assigned` | provisioning_egress_node | PC de atendente usado como saída (id em `egress_pcs`) ligado ou desligado de uma pessoa (metadados: userId) |

Metadados nunca devem conter token, senha, áudio, código SMS ou código de pareamento. Telefone, e-mail e notas só pertencem às tabelas de domínio que realmente precisam deles; não devem ser enviados a logs ou Sentry.
