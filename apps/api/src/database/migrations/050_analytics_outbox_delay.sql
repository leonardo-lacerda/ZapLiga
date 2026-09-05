-- Lote 11: latência observável entre registro e publicação do outbox analítico.
ALTER TABLE analytics_reconciliation_runs
  ADD COLUMN IF NOT EXISTS outbox_delay_seconds NUMERIC(12,3);
