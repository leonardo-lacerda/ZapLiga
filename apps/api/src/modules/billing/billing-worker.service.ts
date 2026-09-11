import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { BillingService } from './billing.service';

@Injectable()
export class BillingWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BillingWorkerService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastReconcileAt = 0;

  constructor(private readonly billing: BillingService, @Optional() private readonly redis?: RedisService) {}

  onModuleInit() {
    if (String(process.env.BILLING_WORKER_ENABLED ?? 'true').toLowerCase() === 'false') return;
    const interval = Math.max(5_000, Number(process.env.BILLING_WORKER_INTERVAL_MS ?? 15_000));
    this.timer = setInterval(() => void this.run(), interval);
    this.timer.unref?.();
    void this.run();
  }

  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  private async run() {
    if (this.running) return;
    this.running = true;
    const lockName = 'zapcall:billing:worker-lock';
    const lockToken = randomUUID();
    if (this.redis && !await this.redis.acquireLock(lockName, lockToken, 5 * 60_000).catch(() => false)) {
      this.running = false;
      return;
    }
    try {
      await this.billing.processPendingWebhooks(25);
      await this.billing.applyScheduledSeatChanges(25);
      await this.billing.applyScheduledPlanChanges(25);
      const reconcileInterval = Math.max(60_000, Number(process.env.BILLING_RECONCILE_INTERVAL_MS ?? 300_000));
      if (Date.now() - this.lastReconcileAt >= reconcileInterval) {
        this.lastReconcileAt = Date.now();
        await this.billing.reconcileStaleTenants(5);
      }
    }
    catch (error) { this.logger.warn(`Falha no worker de billing: ${String(error)}`); }
    finally {
      if (this.redis) await this.redis.releaseLock(lockName, lockToken).catch(() => undefined);
      this.running = false;
    }
  }
}
