import { Body, Controller, Param, Patch, UseGuards } from '@nestjs/common';
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
import { ProjectStatusService } from './project-status.service';
import {
  ProjectStatusChangeDto,
  UpdateProjectStatusDto,
} from './project-status.dto';

@Controller('projects')
@ApiTags('Projects')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles([UserRole.STUDENT, UserRole.SUPERVISOR])
@ApiResponse({ status: 401, description: 'Missing or invalid access token' })
export class ProjectStatusController {
  constructor(private readonly projectStatus: ProjectStatusService) {}

  @Patch(':id/status')
  @ApiOperation({
    summary: 'Change the project status',
    description:
      'The team leader: PLANNING <-> IN_PROGRESS <-> REVIEW (REVIEW = submit for final review). ' +
      'The project supervisor: any status, including COMPLETED and ARCHIVED. ' +
      'Everyone else on the project is notified (in-app + email when enabled).',
  })
  @ApiOkResponse({ type: ProjectStatusChangeDto })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({
    status: 403,
    description:
      'NOT_TEAM_LEADER, PROJECT_ACCESS_DENIED or PROJECT_STATUS_NOT_ALLOWED',
  })
  @ApiResponse({ status: 404, description: 'PROJECT_NOT_FOUND' })
  @ApiResponse({
    status: 409,
    description: 'PROJECT_STATUS_UNCHANGED or PROJECT_STATUS_CONFLICT',
  })
  change(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateProjectStatusDto,
  ) {
    return this.projectStatus.changeStatus(user, id, dto);
  }
}
