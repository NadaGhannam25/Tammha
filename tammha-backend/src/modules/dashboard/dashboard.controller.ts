import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '@modules/auth/guards/roles.guard';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { AuthUser } from '@common/types/auth-user.type';
import { DashboardService } from './dashboard.service';
import { DashboardQueryDto } from './dto/dashboard-query.dto';
import {
  StudentDashboardDto,
  SupervisorDashboardDto,
} from './dto/dashboard-response.dto';

@Controller('dashboard')
@ApiTags('Dashboard')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiResponse({ status: 401, description: 'Missing or invalid access token' })
@ApiResponse({ status: 403, description: 'Wrong role for this dashboard' })
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('student')
  @Roles([UserRole.STUDENT])
  @ApiOperation({
    summary: 'Student dashboard (own project)',
    description:
      'Project, completion %, task counts (total/completed/pending/overdue), milestones with progress, ' +
      'upcoming deadlines, latest documents and supervisor feedback (hidden scores stay hidden), ' +
      'upcoming meetings, unread notifications, submission status summary, progress and readiness. ' +
      'Without a team/project: hasProject=false and empty sections.',
  })
  @ApiOkResponse({ type: StudentDashboardDto })
  student(@CurrentUser() user: AuthUser, @Query() query: DashboardQueryDto) {
    return this.dashboardService.getStudentDashboard(user, query);
  }

  @Get('supervisor')
  @Roles([UserRole.SUPERVISOR])
  @ApiOperation({
    summary: 'Supervisor dashboard (supervised projects)',
    description:
      'Per-project progress/readiness and task/milestone counts, overdue projects and tasks, ' +
      'latest submissions (uploads and new versions), items awaiting review and upcoming meetings. ' +
      'All projects are aggregated with a fixed number of queries.',
  })
  @ApiOkResponse({ type: SupervisorDashboardDto })
  supervisor(@CurrentUser() user: AuthUser, @Query() query: DashboardQueryDto) {
    return this.dashboardService.getSupervisorDashboard(user, query);
  }
}
