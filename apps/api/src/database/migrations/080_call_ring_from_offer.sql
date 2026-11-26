-- Ring time of each call measured from the offer Waxum sent to WhatsApp (calls.offer_sent_at, 078)
-- until the lead answered or the call ended. started_at is only stamped on answer, so the old
-- formula gave 0 for answered calls and nothing for unanswered ones. Recomputes the calls that
-- already have an offer time; the dialer writes the new value from now on.
UPDATE calls
SET ring_duration_seconds = GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(connected_at, ended_at) - offer_sent_at))::int)
WHERE offer_sent_at IS NOT NULL AND ended_at IS NOT NULL;
