import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

// Every process gets an ownership token. It is used to distinguish calls and
// SDR sockets belonging to a live process from work left by a crashed one.
// An explicit value is useful in orchestrated environments; otherwise the
// process-local value is intentionally unique on every boot.
export const runtimeInstanceId = process.env.API_INSTANCE_ID || `${hostname()}:${process.pid}:${randomUUID()}`;
export const runtimeHeartbeatKey = `zapcall:runtime:${runtimeInstanceId}`;
