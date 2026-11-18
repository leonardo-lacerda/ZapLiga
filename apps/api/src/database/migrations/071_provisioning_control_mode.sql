-- "Abrir o phone": a control session applies the PC's proxy, starts the phone, checks its IP
-- and leaves it with the operator on the live screen until they end it (then it powers off).
-- Like network_check, it has no app and no number.
ALTER TABLE provisioning_jobs DROP CONSTRAINT IF EXISTS provisioning_jobs_mode_check;
ALTER TABLE provisioning_jobs ADD CONSTRAINT provisioning_jobs_mode_check
  CHECK (mode IN ('register', 'network_check', 'control'));
