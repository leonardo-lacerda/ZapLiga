export const normalizeEmail = (value: unknown) => String(value ?? '').trim().toLowerCase();

export const publicUser = (user: any) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  platformRole: user.platform_role,
  status: user.status,
  createdAt: user.created_at,
  lastLoginAt: user.last_login_at,
});
