-- Keep automatic dialing fair: each lead is attempted at most once per round.
-- Manual calls are tracked separately and do not consume automatic attempts.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS last_auto_round INTEGER NOT NULL DEFAULT 0;

ALTER TABLE dialer_settings
  ADD COLUMN IF NOT EXISTS dialer_round INTEGER NOT NULL DEFAULT 1;

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'automatico';

CREATE INDEX IF NOT EXISTS leads_tenant_auto_round_idx
  ON leads (tenant_id, last_auto_round, status, next_eligible_at)
  WHERE do_not_call = false;
