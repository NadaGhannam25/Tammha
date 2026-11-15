import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NotificationType } from '@prisma/client';
import { IsBoolean, IsEnum, IsOptional } from 'class-validator';
import { PageMetaDto, PaginationDto } from '@common/dtos/pagination.dto';
import { QueryBoolean } from '@common/utils/query-boolean.transform';

export class NotificationQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'true = read only, false = unread only' })
  @IsOptional()
  @QueryBoolean()
  @IsBoolean()
  isRead?: boolean;

  @ApiPropertyOptional({ enum: NotificationType })
  @IsOptional()
  @IsEnum(NotificationType)
  type?: NotificationType;
}

/** Pagination only (used by GET /notifications/unread). */
export class UnreadNotificationQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: NotificationType })
  @IsOptional()
  @IsEnum(NotificationType)
  type?: NotificationType;
}

export class NotificationViewDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: NotificationType }) type!: NotificationType;
  @ApiProperty() title!: string;
  @ApiProperty() message!: string;
  @ApiProperty({
    nullable: true,
    type: Object,
    description:
      'Context for the frontend, e.g. { kind, projectId, taskId | documentId | feedbackId | meetingId }',
    example: { kind: 'task_due_soon', taskId: 'cl…', projectId: 'cl…' },
  })
  data!: Record<string, unknown> | null;
  @ApiProperty() isRead!: boolean;
  @ApiProperty({ nullable: true, type: Date }) readAt!: Date | null;
  @ApiProperty() createdAt!: Date;
}

export class NotificationPageDto {
  @ApiProperty({ type: [NotificationViewDto] }) items!: NotificationViewDto[];
  @ApiProperty({ type: PageMetaDto }) meta!: PageMetaDto;
  @ApiProperty({ description: 'All unread notifications of the user' })
  unreadCount!: number;
}

export class UnreadCountDto {
  @ApiProperty() unreadCount!: number;
}

export class MarkAllReadDto {
  @ApiProperty({ description: 'Notifications that changed to read' })
  updated!: number;
}
