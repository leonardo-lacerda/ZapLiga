import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsDateString, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class RescheduleCallbackDto { @IsDateString() dueAt!: string; @IsOptional() @IsString() @MaxLength(1000) notes?: string; }
export class ReassignCallbackDto { @IsOptional() @IsString() assignedSdrId?: string; }
export class CancelCallbackDto { @IsString() @MaxLength(1000) reason!: string; @IsOptional() @IsIn(['cancelled', 'missed']) status?: 'cancelled' | 'missed'; }
export class BulkReassignCallbacksDto { @IsArray() @ArrayNotEmpty() @ArrayMaxSize(500) @IsString({ each: true }) callbackIds!: string[]; @IsOptional() @IsString() assignedSdrId?: string; }
