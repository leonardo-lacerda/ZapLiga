/**
 * Temporary compatibility context used while the operational routes are still
 * being moved to authenticated tenant routes. Phase 3 will replace this with
 * the tenant resolved from the authenticated request.
 */
export function legacyTenantId() {
  return process.env.LEGACY_TENANT_ID ?? 'tenant-legado';
}
