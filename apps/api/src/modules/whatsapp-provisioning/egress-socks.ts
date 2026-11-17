import type { WorkerProbeProxy, WorkerProxy } from '../../infrastructure/geelark-worker/geelark-worker.client';

/**
 * The SOCKS gateway that takes a cloud phone out through an attendant's PC
 * (docs/provisioning-contract.md, section 4). The proxy user is the PC's slot
 * (`edge-N`) and the password is EGRESS_SOCKS_PASSWORD; the gateway forwards to
 * the slot's network, which goes out through the PC.
 */
export type EgressSocksConfig = { publicHost: string; port: number; password: string; internalHost: string; internalPort: number };

export const DEFAULT_SOCKS_PORT = 1080;
const DEFAULT_INTERNAL = 'socks-gateway:1080';

const parsePort = (value: string | undefined, fallback: number) => {
  const port = Number(String(value ?? '').trim());
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
};

/** "socks-gateway:1080", "socks5://socks-gateway:1080" or "[::1]:1080" -> host + port. */
export const parseSocksAddress = (value: string) => {
  const address = value.trim().replace(/^socks5h?:\/\//i, '').replace(/\/.*$/, '');
  const bracketed = address.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) return { host: bracketed[1], port: parsePort(bracketed[2], DEFAULT_SOCKS_PORT) };
  const [host, port] = address.split(':');
  return { host: host || 'socks-gateway', port: parsePort(port, DEFAULT_SOCKS_PORT) };
};

/** `null` while the public host or the password is missing: the cadastro cannot go out through a PC. */
export const egressSocksConfig = (env: NodeJS.ProcessEnv = process.env): EgressSocksConfig | null => {
  const publicHost = env.EGRESS_SOCKS_PUBLIC_HOST?.trim() ?? '';
  const password = env.EGRESS_SOCKS_PASSWORD ?? '';
  if (!publicHost || !password) return null;
  const internal = parseSocksAddress(env.EGRESS_SOCKS_INTERNAL_URL?.trim() || DEFAULT_INTERNAL);
  return { publicHost, port: parsePort(env.EGRESS_SOCKS_PORT, DEFAULT_SOCKS_PORT), password, internalHost: internal.host, internalPort: internal.port };
};

/** What the phone uses (public address) and what the worker probes the PC's IP through (internal address). */
export const socksProxiesFor = (config: EgressSocksConfig, slot: string): { proxy: WorkerProxy; probeProxy: WorkerProbeProxy } => ({
  proxy: { typeId: 1, server: config.publicHost, port: config.port, username: slot, password: config.password },
  probeProxy: { server: config.internalHost, port: config.internalPort, username: slot, password: config.password },
});
