-- Commercial SDR capacity is intentionally small and explicit:
-- Starter: up to 2, Growth: up to 5, Pro: up to 10.
-- Included seats equal the plan cap, so an organization must upgrade to add
-- capacity beyond its current plan. The per-seat addon remains available for
-- future catalog tiers whose included seats are below their commercial cap.
UPDATE billing_plan_versions
SET max_sdrs = CASE code
      WHEN 'starter' THEN 2
      WHEN 'growth' THEN 5
      WHEN 'pro' THEN 10
      ELSE max_sdrs
    END,
    included_sdrs = CASE code
      WHEN 'starter' THEN 2
      WHEN 'growth' THEN 5
      WHEN 'pro' THEN 10
      ELSE included_sdrs
    END,
    description = CASE code
      WHEN 'starter' THEN 'Para equipes pequenas - ate 2 SDRs'
      WHEN 'growth' THEN 'Para operacoes em crescimento - ate 5 SDRs'
      WHEN 'pro' THEN 'Para operacoes avancadas - ate 10 SDRs'
      ELSE description
    END,
    updated_at = now()
WHERE code IN ('starter', 'growth', 'pro');
