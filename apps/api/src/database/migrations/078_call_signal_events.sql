-- Every WhatsApp signal around a call, to read what WhatsApp answers to each offer instead of
-- guessing (docs/waxum-version.md, "Sinais de chamada"):
-- - calls.waxum_call_id / offer_sent_at: the call id Waxum gives the offer and when it went out.
-- - call_signal_events: each answer to the offer (receipt, preaccept, accept, reject, terminate,
--   ...), and each logout or stream error of the line right after an offer, with the ms since it.
ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS waxum_call_id TEXT,
  ADD COLUMN IF NOT EXISTS offer_sent_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS calls_waxum_call_id_idx ON calls (waxum_call_id) WHERE waxum_call_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS call_signal_events (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id TEXT NOT NULL,
  number_id TEXT NOT NULL,
  call_id TEXT,
  waxum_call_id TEXT,
  kind TEXT NOT NULL,
  ms_since_offer INTEGER,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS call_signal_events_number_received_idx ON call_signal_events (tenant_id, number_id, received_at DESC);
CREATE INDEX IF NOT EXISTS call_signal_events_call_idx ON call_signal_events (call_id) WHERE call_id IS NOT NULL;
