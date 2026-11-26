-- Proxy slots (docs/saida-por-proxy.md): a line can go out through a residential SOCKS5 proxy of
-- its own instead of an attendant's PC.
-- - egress_proxies: one per proxy slot (proxy-N); the proxy URL is encrypted like the Tailscale
--   secret; the slot's watcher reports its route, exit IP, UDP check and latency every minute.
-- - egress_proxy_usage: bytes through the proxy per slot, line and day (São Paulo), total and UDP
--   (the call media), to size the GB the operation needs per month.
-- - egress_proxy_events: exit IP changes and the proxy going down or up.
CREATE TABLE IF NOT EXISTS egress_proxies (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name TEXT NOT NULL,
  slot TEXT NOT NULL UNIQUE,
  proxy_url_encrypted TEXT NOT NULL,
  route TEXT NOT NULL DEFAULT 'offline',
  route_reported_at TIMESTAMPTZ,
  exit_ip TEXT,
  exit_ip_changed_at TIMESTAMPTZ,
  udp_ok BOOLEAN,
  latency_ms INTEGER,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS egress_proxy_usage (
  slot TEXT NOT NULL,
  day DATE NOT NULL,
  number_id TEXT NOT NULL DEFAULT '',
  rx_bytes BIGINT NOT NULL DEFAULT 0,
  tx_bytes BIGINT NOT NULL DEFAULT 0,
  udp_rx_bytes BIGINT NOT NULL DEFAULT 0,
  udp_tx_bytes BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (slot, day, number_id)
);
CREATE INDEX IF NOT EXISTS egress_proxy_usage_number_day_idx ON egress_proxy_usage (number_id, day DESC);

CREATE TABLE IF NOT EXISTS egress_proxy_events (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  slot TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ip_changed', 'down', 'up')),
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS egress_proxy_events_slot_idx ON egress_proxy_events (slot, occurred_at DESC);
