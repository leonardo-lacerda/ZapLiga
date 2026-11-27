/**
 * Identity a line asks its Waxum to present (docs/stealth-profile.md, docs/device-profile.md).
 * Spread into the body of the session requests (create, connect, pair, adopt) next to their own
 * fields; absent, the body is exactly the one sent before this existed.
 *
 * - `device`: registration props, sent to WhatsApp only when the line pairs (Waxum v1 field).
 * - `client_profile`: the login profile, saved by Waxum with the session (v8; v7 ignores it).
 *   `locale` is the login language; `android` (v11) makes the line log in as that Android phone,
 *   WhatsApp Business when `business` (v12);
 *   `reset` first deletes the identity Waxum saved, then applies the rest of the same request.
 */
export type SessionDeviceProps = { os: string; platform: string };
export type SessionAndroidProfile = { os_version: string; manufacturer: string; device: string; mcc: string; mnc: string; phone_id: string; business: boolean };
export type SessionClientProfile = { locale?: string; reset?: true; android?: SessionAndroidProfile };
export type SessionIdentity = { device?: SessionDeviceProps; client_profile?: SessionClientProfile };
