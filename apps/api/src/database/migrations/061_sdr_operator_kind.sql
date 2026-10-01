-- Who an operator row (sdrs) belongs to. Leaders and platform admins can now run a calling
-- station too; they keep their role, they just get an operator row. The kind lets reports keep a
-- platform admin out of a tenant's rankings/goals while still counting the calls they made.
ALTER TABLE sdrs ADD COLUMN IF NOT EXISTS operator_kind TEXT NOT NULL DEFAULT 'sdr';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sdrs_operator_kind_check') THEN
    ALTER TABLE sdrs ADD CONSTRAINT sdrs_operator_kind_check CHECK (operator_kind IN ('sdr', 'leader', 'platform_admin'));
  END IF;
END $$;

-- Rows left behind when an SDR was promoted to leader (setRole never deleted them).
UPDATE sdrs s SET operator_kind = 'leader'
FROM tenant_memberships tm
WHERE tm.tenant_id = s.tenant_id AND tm.user_id = s.user_id AND tm.role = 'leader' AND s.operator_kind = 'sdr';
