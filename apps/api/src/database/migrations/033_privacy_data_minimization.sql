ALTER TABLE data_subject_requests ADD COLUMN IF NOT EXISTS details_encrypted TEXT;

-- Notes are operational free text and are not necessary in the immutable
-- compliance event once the reason/source and suppression id are recorded.
UPDATE contact_compliance_events SET evidence = evidence - 'notes' WHERE evidence ? 'notes';
