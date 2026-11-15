import {
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { AuthUser } from '@common/types/auth-user.type';
import { NotificationsService } from './notifications.service';
import {
  MarkAllReadDto,
  NotificationPageDto,
  NotificationQueryDto,
  NotificationViewDto,
  UnreadCountDto,
  UnreadNotificationQueryDto,
} from './dto/notification.dto';

/** The current user's own notifications only (any role). */
@Controller('notifications')
@ApiTags('Notifications')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard)
@ApiResponse({ status: 401, description: 'Missing or invalid access token' })
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({
    summary: 'List my notifications (newest first)',
    description: 'Filters: isRead, type. Response includes unreadCount.',
  })
  @ApiOkResponse({ type: NotificationPageDto })
  list(@CurrentUser() user: AuthUser, @Query() query: NotificationQueryDto) {
    return this.notifications.list(user.id, query);
  }

  @Get('unread')
  @ApiOperation({ summary: 'List my unread notifications (newest first)' })
  @ApiOkResponse({ type: NotificationPageDto })
  unread(
    @CurrentUser() user: AuthUser,
    @Query() query: UnreadNotificationQueryDto,
  ) {
    return this.notifications.list(user.id, query, true);
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Number of my unread notifications (badge)' })
  @ApiOkResponse({ type: UnreadCountDto })
  unreadCount(@CurrentUser() user: AuthUser) {
    return this.notifications.unreadCount(user.id);
  }

  @Patch('read-all')
  @ApiOperation({ summary: 'Mark all my notifications as read' })
  @ApiOkResponse({ type: MarkAllReadDto })
  markAllRead(@CurrentUser() user: AuthUser) {
    return this.notifications.markAllRead(user.id);
  }

  @Patch(':id/read')
  @ApiOperation({
    summary: 'Mark one of my notifications as read (idempotent)',
    description:
      "Another user's notification returns 404 NOTIFICATION_NOT_FOUND.",
  })
  @ApiOkResponse({ type: NotificationViewDto })
  @ApiResponse({ status: 404, description: 'NOTIFICATION_NOT_FOUND' })
  markRead(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.notifications.markRead(user.id, id);
  }
}
