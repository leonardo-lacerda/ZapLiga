import { IsIn, IsObject, IsOptional } from 'class-validator';
import { RecommendationEventType } from '../recommendations.types';

export class RecommendationEventDto {
  @IsIn(['impression', 'opened', 'snoozed', 'dismissed', 'applied', 'failed', 'resolved']) eventType!: RecommendationEventType;
  @IsOptional() @IsObject() metadata?: Record<string, unknown>;
}
