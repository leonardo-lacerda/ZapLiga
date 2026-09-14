import { IsString, MaxLength, MinLength } from 'class-validator';
import { PlanChangeDto } from './plan-change.dto';
import { SeatChangeDto } from './seat-change.dto';

export class AdminBillingPlanChangeDto extends PlanChangeDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class AdminBillingSeatChangeDto extends SeatChangeDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class AdminBillingCheckoutDto extends PlanChangeDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
