# ADR 005 — Retenção e anonimização

Status: implementação aceita; texto final sujeito à validação jurídica. Responsável: DPO/Jurídico.

Anonimização remove nome, telefone operacional e notas de lead/chamada, preservando identificadores técnicos e métricas agregadas. A supressão canônica original permanece para evitar novo contato. Exportações são autenticadas, auditadas e expiram em 24 horas. Solicitações e eventos permanecem como trilha de cumprimento. A chave `DATA_PROTECTION_SECRET` protege o telefone armazenado na solicitação e deve ter backup/rotação controlados. Jurídico deve validar prazos e hipóteses legais antes do Gate B.
