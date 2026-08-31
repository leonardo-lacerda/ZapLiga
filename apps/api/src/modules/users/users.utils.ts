export const normalizeEmail = (value: unknown) => String(value ?? '').trim().toLowerCase();

export const publicUser = (user: any) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  platformRole: user.platform_role,
  status: user.status,
  createdAt: user.created_at,
  lastLoginAt: user.last_login_at,
  emailVerifiedAt: user.email_verified_at ?? null,
  passwordChangedAt: user.password_changed_at ?? null,
  forcePasswordChange: Boolean(user.force_password_change),
});
