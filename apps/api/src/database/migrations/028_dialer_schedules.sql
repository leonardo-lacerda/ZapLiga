-- Janelas operacionais do discador. Os horários são civis no fuso do tenant.
CREATE TABLE IF NOT EXISTS dialer_schedule_windows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (start_time < end_time),
  UNIQUE (tenant_id, day_of_week, start_time, end_time)
);

CREATE INDEX IF NOT EXISTS dialer_schedule_windows_tenant_day_idx
  ON dialer_schedule_windows (tenant_id, day_of_week, start_time);

CREATE TABLE IF NOT EXISTS dialer_schedule_exceptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  local_date DATE NOT NULL,
  is_closed BOOLEAN NOT NULL DEFAULT true,
  start_time TIME,
  end_time TIME,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (is_closed AND start_time IS NULL AND end_time IS NULL)
    OR
    (NOT is_closed AND start_time IS NOT NULL AND end_time IS NOT NULL AND start_time < end_time)
  ),
  UNIQUE (tenant_id, local_date)
);

CREATE INDEX IF NOT EXISTS dialer_schedule_exceptions_tenant_date_idx
  ON dialer_schedule_exceptions (tenant_id, local_date);

CREATE OR REPLACE FUNCTION seed_default_dialer_schedule(target_tenant_id TEXT) RETURNS void AS $$
BEGIN
  INSERT INTO dialer_schedule_windows (tenant_id, day_of_week, start_time, end_time)
  SELECT target_tenant_id, weekday, TIME '09:00', TIME '18:00'
  FROM generate_series(1, 5) AS weekday
  ON CONFLICT DO NOTHING;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE tenant_row RECORD;
BEGIN
  FOR tenant_row IN SELECT id FROM tenants LOOP
    PERFORM seed_default_dialer_schedule(tenant_row.id);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION seed_dialer_schedule_for_new_tenant() RETURNS TRIGGER AS $$
BEGIN
  PERFORM seed_default_dialer_schedule(NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tenants_seed_dialer_schedule_trg ON tenants;
CREATE TRIGGER tenants_seed_dialer_schedule_trg
AFTER INSERT ON tenants
FOR EACH ROW EXECUTE FUNCTION seed_dialer_schedule_for_new_tenant();
