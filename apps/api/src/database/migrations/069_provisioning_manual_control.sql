-- On a screen the robot does not know, the job now waits for the operator to drive
-- the phone from the live screen and hand it back ("manual"), instead of failing.
ALTER TABLE provisioning_jobs DROP CONSTRAINT IF EXISTS provisioning_jobs_awaiting_check;
ALTER TABLE provisioning_jobs ADD CONSTRAINT provisioning_jobs_awaiting_check
  CHECK (awaiting IS NULL OR awaiting IN ('sms', 'profile', 'link_decision', 'pair_code', 'manual'));
