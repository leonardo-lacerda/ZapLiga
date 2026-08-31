# ADR 001 — Supressão e consentimento

Status: aceito para lançamento. Responsável: Produto + DPO.

`contact_suppressions` é a fonte canônica e `leads.do_not_call` é apenas projeção. Opt-out do titular bloqueia toda chamada, inclusive manual, callback e uma reserva concorrente. Exclusão, reset ou reimportação de lead não remove a restrição. SDR pode registrar opt-out; somente líder ou super admin pode retirar, com justificativa auditada. `numero_invalido` sugere revisão, mas não cria opt-out do titular automaticamente.

Telefone, motivo e evidência mínima são retidos enquanto necessários para impedir contato indevido. Qualquer mudança desta regra exige aprovação do DPO.
