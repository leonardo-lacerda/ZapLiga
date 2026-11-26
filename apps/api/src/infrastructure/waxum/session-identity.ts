/**
 * Identity a line asks its Waxum to present (docs/stealth-profile.md). Spread into the body of
 * the session requests (create, connect, pair, adopt) next to their own fields; absent, the body
 * is exactly the one sent before this existed.
 *
 * - `device`: registration props, sent to WhatsApp only when the line pairs (Waxum v1 field).
 * - `client_profile`: the login locale, sent on every login (Waxum v8; v7 ignores it). `reset`
 *   deletes the identity Waxum saved with the session.
 */
export type SessionDeviceProps = { os: string; platform: string };
export type SessionClientProfile = { locale: string } | { reset: true };
export type SessionIdentity = { device?: SessionDeviceProps; client_profile?: SessionClientProfile };
