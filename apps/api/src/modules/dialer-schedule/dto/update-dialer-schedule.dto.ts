import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';

const localTimePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

export class DialerScheduleWindowDto {
  @IsInt() @Min(0) @Max(6) day_of_week!: number;
  @Matches(localTimePattern) start_time!: string;
  @Matches(localTimePattern) end_time!: string;
}

export class DialerScheduleExceptionDto {
  @IsDateString({ strict: true }) local_date!: string;
  @IsBoolean() is_closed!: boolean;
  @IsOptional() @Matches(localTimePattern) start_time?: string;
  @IsOptional() @Matches(localTimePattern) end_time?: string;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

export class UpdateDialerScheduleDto {
  @IsString() @MaxLength(100) timezone!: string;
  @IsArray() @ArrayMaxSize(28) @ValidateNested({ each: true }) @Type(() => DialerScheduleWindowDto)
  windows!: DialerScheduleWindowDto[];
  @IsArray() @ArrayMaxSize(366) @ValidateNested({ each: true }) @Type(() => DialerScheduleExceptionDto)
  exceptions!: DialerScheduleExceptionDto[];
}
