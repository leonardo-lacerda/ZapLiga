import { Module } from '@nestjs/common';
import { WaxumClient } from '../../infrastructure/waxum/waxum.client';
import { SdrGateway } from '../sdrs/sdr.gateway';
import { DialerService } from './dialer.service';

@Module({
  providers: [WaxumClient, DialerService, SdrGateway],
  exports: [DialerService, SdrGateway, WaxumClient],
})
export class DialerModule {}
