# ADR 002 — Agenda de chamadas e timezone

Status: aceito para lançamento. Responsável: Operações.

O fuso de cada empresa vem de `tenants.timezone`. Novas empresas recebem segunda a sexta, 09:00–18:00, no fuso local. Exceções por data prevalecem. A API valida no start, tick, chamada manual e imediatamente antes da chamada externa. O fechamento não encerra chamada em andamento. A flag `schedule_enforcement` permite rollback operacional por tenant e deve permanecer ativa fora de incidente aprovado.
