export type SdrSocketRoute =
  | { kind: 'control'; tenantId?: string }
  | { kind: 'operations'; tenantId: string }
  | { kind: 'media'; tenantId?: string; sdrId: string; callId: string }
  | { kind: 'none' };

// Four URL shapes share this upgrade handler: the tenant-scoped control
// channel, the tenant-scoped operations observer, the tenant-scoped media
// channel, and the legacy (pre-multi-tenant) media channel that still routes
// SDRs that predate scoped URLs.
export function parseSdrSocketPath(pathname: string): SdrSocketRoute {
  const scopedControl = pathname.match(/^\/ws\/tenants\/([^/]+)\/sdr$/);
  const scopedOperations = pathname.match(/^\/ws\/tenants\/([^/]+)\/operations$/);
  if (pathname === '/ws/sdr' || scopedControl) return { kind: 'control', tenantId: scopedControl?.[1] };
  if (scopedOperations) return { kind: 'operations', tenantId: scopedOperations[1] };
  const scopedMedia = pathname.match(/^\/ws\/tenants\/([^/]+)\/sdr\/([^/]+)\/call\/([^/]+)$/);
  if (scopedMedia) return { kind: 'media', tenantId: scopedMedia[1], sdrId: scopedMedia[2], callId: scopedMedia[3] };
  const legacyMedia = pathname.match(/^\/ws\/sdr\/([^/]+)\/call\/([^/]+)$/);
  if (legacyMedia) return { kind: 'media', sdrId: legacyMedia[1], callId: legacyMedia[2] };
  return { kind: 'none' };
}
