import { Controller, Get, Param, UseGuards } from '@nestjs/common';
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
import {
  ProjectProgressResponseDto,
  ReadinessDto,
} from './dto/dashboard-response.dto';

/** GET /projects/:id/progress and /readiness — deterministic, rule-based (no AI). */
@Controller('projects')
@ApiTags('Projects')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles([UserRole.STUDENT, UserRole.SUPERVISOR])
@ApiResponse({ status: 401, description: 'Missing or invalid access token' })
@ApiResponse({ status: 403, description: 'PROJECT_ACCESS_DENIED' })
@ApiResponse({ status: 404, description: 'PROJECT_NOT_FOUND' })
export class ProjectProgressController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get(':id/progress')
  @ApiOperation({
    summary: 'Project progress and readiness with the full explanation',
    description:
      'Progress = weighted completion (tasks 50, milestones 30, approved required documents 20; ' +
      'components without items are left out). Readiness = rule checklist worth 100 points ' +
      '(tasks, milestones, required documents submitted/approved, change requests addressed, nothing overdue). ' +
      'Every component shows its numbers; aiUsed is always false.',
  })
  @ApiOkResponse({ type: ProjectProgressResponseDto })
  progress(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.dashboardService.getProjectProgress(user, id);
  }

  @Get(':id/readiness')
  @ApiOperation({
    summary: 'Project readiness only (criteria, points, next steps)',
  })
  @ApiOkResponse({ type: ReadinessDto })
  async readiness(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return (await this.dashboardService.getProjectProgress(user, id)).readiness;
  }
}
