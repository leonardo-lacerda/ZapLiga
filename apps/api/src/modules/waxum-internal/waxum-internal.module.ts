import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { NumbersModule } from '../numbers/numbers.module';
import { WaxumInternalController } from './waxum-internal.controller';

/** Internal routes the Waxum containers call with the API key they already share. */
@Module({ imports: [DatabaseModule, NumbersModule], controllers: [WaxumInternalController] })
export class WaxumInternalModule {}
