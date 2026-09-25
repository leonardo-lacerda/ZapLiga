import { BadRequestException, Body, Controller, Delete, Get, Headers, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { StripeClientService } from '../../infrastructure/stripe/stripe.client';
import { AuthGuard, CurrentTenant, CurrentUser, Roles, RolesGuard, TenantAction, TenantMembershipGuard } from '../auth/auth.guards';
import { BillingService } from './billing.service';
import { EntitlementService } from './entitlement.service';
import { CheckoutSessionDto } from './dto/checkout-session.dto';
import { ManualGrantDto } from './dto/manual-grant.dto';
import { SeatChangeDto } from './dto/seat-change.dto';
import { EntitlementOverrideDto } from './dto/entitlement-override.dto';
import { PlanChangeDto } from './dto/plan-change.dto';
import { AdminBillingCheckoutDto, AdminBillingPlanChangeDto, AdminBillingSeatChangeDto } from './dto/admin-billing.dto';

@Controller()
@UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard)
@Roles('leader', 'super_admin')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('/api/tenants/:tenantId/billing')
  status(@CurrentTenant() tenantId: string) { return this.billing.getTenantBilling(tenantId); }

  @Get('/api/tenants/:tenantId/billing/plans')
  plans() { return this.billing.listPlans(); }

  @Get('/api/tenants/:tenantId/billing/catalog')
  catalog() { return this.billing.listPlans(); }

  @Post('/api/tenants/:tenantId/billing/checkout-session')
  @TenantAction('billing_recovery')
  checkout(@CurrentTenant() tenantId: string, @CurrentUser() user: any, @Body() body: CheckoutSessionDto, @Headers('idempotency-key') idempotencyKey?: string) {
    return this.billing.createCheckoutSession(tenantId, user.id, { ...body, idempotencyKey });
  }

  @Post('/api/tenants/:tenantId/billing/portal-session')
  @TenantAction('billing_recovery')
  portal(@CurrentTenant() tenantId: string, @CurrentUser() user: any, @Body() body: { returnUrl?: string }) {
    return this.billing.createPortalSession(tenantId, user.id, body?.returnUrl);
  }

  @Post('/api/tenants/:tenantId/billing/seats/preview')
  previewSeats(@CurrentTenant() tenantId: string, @Body() body: SeatChangeDto) {
    return this.billing.previewSeatChange(tenantId, body.totalSdrSeats);
  }

  @Post('/api/tenants/:tenantId/billing/seats')
  @TenantAction('billing_recovery')
  changeSeats(@CurrentTenant() tenantId: string, @CurrentUser() user: any, @Body() body: SeatChangeDto, @Headers('idempotency-key') idempotencyKey?: string) {
    return this.billing.changeSeats(tenantId, user.id, body.totalSdrSeats, idempotencyKey);
  }

  @Post('/api/tenants/:tenantId/billing/plan-change/preview')
  planPreview(@CurrentTenant() tenantId: string, @Body() body: PlanChangeDto) {
    return this.billing.previewPlanChange(tenantId, body.planCode, body.interval, body.totalSdrSeats);
  }

  @Post('/api/tenants/:tenantId/billing/plan-change')
  @TenantAction('billing_recovery')
  planChange(@CurrentTenant() tenantId: string, @CurrentUser() user: any, @Body() body: PlanChangeDto, @Headers('idempotency-key') idempotencyKey?: string) {
    return this.billing.changePlan(tenantId, user.id, body.planCode, body.interval, idempotencyKey, body.totalSdrSeats);
  }

  @Delete('/api/tenants/:tenantId/billing/changes/:changeId')
  @TenantAction('billing_recovery')
  cancelChange(@CurrentTenant() tenantId: string, @CurrentUser() user: any, @Param('changeId') changeId: string) {
    return this.billing.cancelPendingChange(tenantId, changeId, user.id);
  }

  @Post('/api/tenants/:tenantId/billing/reconcile')
  @TenantAction('billing_recovery')
  @Roles('super_admin')
  reconcile(@CurrentTenant() tenantId: string) { return this.billing.reconcileTenant(tenantId); }

  @Post('/api/tenants/:tenantId/billing/manual-grants')
  @TenantAction('billing_recovery')
  @Roles('super_admin')
  grant(@CurrentTenant() tenantId: string, @CurrentUser() user: any, @Body() body: ManualGrantDto) {
    return this.billing.createManualGrant(tenantId, { startsAt: new Date(body.startsAt), expiresAt: new Date(body.expiresAt), maxSdrs: body.maxSdrs, reason: body.reason, actorUserId: user.id });
  }

  @Delete('/api/tenants/:tenantId/billing/manual-grants/:grantId')
  @TenantAction('billing_recovery')
  @Roles('super_admin')
  revoke(@CurrentTenant() tenantId: string, @CurrentUser() user: any, @Param('grantId') grantId: string) {
    return this.billing.revokeManualGrant(tenantId, grantId, user.id);
  }

  @Post('/api/tenants/:tenantId/billing/entitlement-overrides')
  @TenantAction('billing_recovery')
  @Roles('super_admin')
  override(@CurrentTenant() tenantId: string, @CurrentUser() user: any, @Body() body: EntitlementOverrideDto) {
    return this.billing.createOverride(tenantId, { ...body, actorUserId: user.id });
  }

  @Delete('/api/tenants/:tenantId/billing/entitlement-overrides/:overrideId')
  @TenantAction('billing_recovery')
  @Roles('super_admin')
  revokeOverride(@CurrentTenant() tenantId: string, @CurrentUser() user: any, @Param('overrideId') overrideId: string) {
    return this.billing.revokeOverride(tenantId, overrideId, user.id);
  }
}

@Controller('/api/billing/stripe')
export class BillingWebhookController {
  constructor(private readonly billing: BillingService, private readonly stripe: StripeClientService) {}

  @Post('/webhook')
  async webhook(@Req() request: Request & { rawBody?: Buffer }, @Headers('stripe-signature') signature?: string) {
    let event: any;
    try { event = this.stripe.constructEvent(request.rawBody ?? Buffer.from(''), signature); }
    catch { throw new BadRequestException('Webhook Stripe inválido'); }
    return this.billing.recordWebhook(event);
  }
}

@Controller('/api/admin/billing')
@UseGuards(AuthGuard, RolesGuard)
@Roles('super_admin')
export class BillingAdminController {
  constructor(private readonly billing: BillingService, private readonly entitlement: EntitlementService) {}

  @Get('/write-mode')
  writeMode(@CurrentUser() user: any) {
    return this.entitlement.getAdminWriteMode(user.id);
  }

  @Post('/write-mode')
  setWriteMode(@Body() body: { enabled?: unknown }, @CurrentUser() user: any) {
    if (typeof body?.enabled !== 'boolean') throw new BadRequestException('Informe enabled como booleano');
    return this.entitlement.setAdminWriteMode(user.id, body.enabled);
  }

  @Get('/webhooks')
  webhooks(@Query('limit') limit?: string, @Query('status') status?: string) {
    return this.billing.listWebhookEvents(Number(limit), status);
  }

  @Post('/webhooks/:eventId/retry')
  retry(@Param('eventId') eventId: string, @CurrentUser() user: any) {
    return this.billing.retryWebhookEvent(eventId, user.id);
  }
}

// These routes intentionally do not use TenantMembershipGuard. A platform
// administrator may manage a tenant before the administrator is a member of
// that tenant, while RolesGuard still keeps every operation super-admin only.
@Controller('/api/admin/tenants')
@UseGuards(AuthGuard, RolesGuard)
@Roles('super_admin')
export class BillingAdminTenantController {
  constructor(private readonly billing: BillingService) {}

  @Get('/:tenantId/billing')
  status(@Param('tenantId') tenantId: string) {
    return this.billing.getTenantBilling(tenantId);
  }

  @Get('/:tenantId/billing/plans')
  plans() {
    return this.billing.listPlans();
  }

  @Post('/:tenantId/billing/preview')
  preview(@Param('tenantId') tenantId: string, @Body() body: AdminBillingPlanChangeDto) {
    return this.billing.previewAdminChange(tenantId, body.planCode, body.interval ?? 'month', body.totalSdrSeats);
  }

  @Post('/:tenantId/billing/checkout-session')
  checkout(@Param('tenantId') tenantId: string, @CurrentUser() user: any, @Body() body: AdminBillingCheckoutDto, @Headers('idempotency-key') idempotencyKey?: string) {
    return this.billing.createCheckoutSession(tenantId, user.id, {
      planCode: body.planCode,
      interval: body.interval ?? 'month',
      totalSdrSeats: body.totalSdrSeats,
      idempotencyKey,
      bypassEntitlement: true,
      source: 'admin',
      reason: body.reason,
    });
  }

  @Post('/:tenantId/billing/plan-change')
  planChange(@Param('tenantId') tenantId: string, @CurrentUser() user: any, @Body() body: AdminBillingPlanChangeDto, @Headers('idempotency-key') idempotencyKey?: string) {
    return this.billing.changePlan(tenantId, user.id, body.planCode, body.interval, idempotencyKey, body.totalSdrSeats, { bypassEntitlement: true, source: 'admin', reason: body.reason });
  }

  @Post('/:tenantId/billing/seats')
  seats(@Param('tenantId') tenantId: string, @CurrentUser() user: any, @Body() body: AdminBillingSeatChangeDto, @Headers('idempotency-key') idempotencyKey?: string) {
    return this.billing.changeSeats(tenantId, user.id, body.totalSdrSeats, idempotencyKey, { bypassEntitlement: true, source: 'admin', reason: body.reason });
  }

  @Post('/:tenantId/billing/portal-session')
  portal(@Param('tenantId') tenantId: string, @CurrentUser() user: any) {
    return this.billing.createPortalSession(tenantId, user.id, undefined, { bypassEntitlement: true, source: 'admin' });
  }

  @Post('/:tenantId/billing/reconcile')
  reconcile(@Param('tenantId') tenantId: string) {
    return this.billing.reconcileTenant(tenantId);
  }

  @Delete('/:tenantId/billing/changes/:changeId')
  cancelChange(@Param('tenantId') tenantId: string, @Param('changeId') changeId: string, @CurrentUser() user: any) {
    return this.billing.cancelPendingChange(tenantId, changeId, user.id, { source: 'admin' });
  }
}
