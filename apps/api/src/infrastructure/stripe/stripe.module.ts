import { Global, Module } from '@nestjs/common';
import { StripeClientService } from './stripe.client';

@Global()
@Module({ providers: [StripeClientService], exports: [StripeClientService] })
export class StripeModule {}
