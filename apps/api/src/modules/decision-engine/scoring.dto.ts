import { IsArray, IsInt, IsIn, IsObject, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class ScoreWeightsDto {
  @IsOptional() @IsInt() @Min(0) @Max(1000) baseScore?: number;
  @IsOptional() @IsInt() @Min(-50) @Max(50) priorityWeight?: number;
  @IsOptional() @IsInt() @Min(0) @Max(400) recentInboundWeight?: number;
  @IsOptional() @IsInt() @Min(0) @Max(400) ageWeight?: number;
  @IsOptional() @IsInt() @Min(0) @Max(500) callbackDueWeight?: number;
  @IsOptional() @IsInt() @Min(0) @Max(300) attemptsPenalty?: number;
  @IsOptional() @IsInt() @Min(0) @Max(300) fairnessWeight?: number;
  @IsOptional() @IsInt() @Min(1) @Max(168) recentInboundHours?: number;
  @IsOptional() @IsInt() @Min(1) @Max(720) ageHorizonHours?: number;
}

export class UpdateDecisionPolicyDto {
  @IsObject() weights!: ScoreWeightsDto;
  @IsOptional() @IsString() @MaxLength(500) rationale?: string;
}

export class SimulateDecisionDto {
  @IsOptional() @IsString() leadId?: string;
  @IsOptional() @IsInt() @Min(1) @Max(100) limit?: number;
}

export class DecisionModeDto {
  @IsIn(['disabled', 'shadow', 'active']) mode!: 'disabled' | 'shadow' | 'active';
}
