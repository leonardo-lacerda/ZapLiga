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

Metadados nunca devem conter token, senha ou áudio. Telefone, e-mail e notas só pertencem às tabelas de domínio que realmente precisam deles; não devem ser enviados a logs ou Sentry.
