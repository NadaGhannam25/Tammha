import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
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
import { MessageDto } from '@modules/teams/dto/team-response.dto';
import { MilestonesService } from './milestones.service';
import {
  CreateMilestoneDto,
  MilestonePageDto,
  MilestoneQueryDto,
  MilestoneViewDto,
  UpdateMilestoneDto,
} from './dto/milestone.dto';

@Controller('milestones')
@ApiTags('Milestones')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles([UserRole.STUDENT, UserRole.SUPERVISOR])
@ApiResponse({ status: 401, description: 'Missing or invalid access token' })
@ApiResponse({
  status: 403,
  description:
    'Role not allowed, PROJECT_ACCESS_DENIED, or NOT_TEAM_LEADER (writes are leader-only)',
})
export class MilestonesController {
  constructor(private readonly milestonesService: MilestonesService) {}

  @Post()
  @Roles([UserRole.STUDENT])
  @ApiOperation({
    summary: 'Create a milestone / project stage (team leader)',
    description:
      'Members and the supervisor can read milestones; only the team leader manages them.',
  })
  @ApiCreatedResponse({ type: MilestoneViewDto })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 404, description: 'PROJECT_NOT_FOUND' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateMilestoneDto) {
    return this.milestonesService.create(user, dto);
  }

  @Get()
  @ApiOperation({
    summary: 'List milestones with progress',
    description:
      'Students see their own project; supervisors see the projects they supervise. Sorted by dueDate.',
  })
  @ApiOkResponse({ type: MilestonePageDto })
  findMany(@CurrentUser() user: AuthUser, @Query() query: MilestoneQueryDto) {
    return this.milestonesService.findMany(user, query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a milestone with progress',
    description: 'List its tasks with GET /tasks?milestoneId=<id>.',
  })
  @ApiOkResponse({ type: MilestoneViewDto })
  @ApiResponse({ status: 404, description: 'MILESTONE_NOT_FOUND' })
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.milestonesService.findOne(user, id);
  }

  @Patch(':id')
  @Roles([UserRole.STUDENT])
  @ApiOperation({
    summary: 'Update a milestone, its stage order or status (team leader)',
  })
  @ApiOkResponse({ type: MilestoneViewDto })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 404, description: 'MILESTONE_NOT_FOUND' })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateMilestoneDto,
  ) {
    return this.milestonesService.update(user, id, dto);
  }

  @Delete(':id')
  @Roles([UserRole.STUDENT])
  @ApiOperation({
    summary: 'Delete a milestone (team leader)',
    description: 'Its tasks are kept and lose the milestone link.',
  })
  @ApiOkResponse({ type: MessageDto })
  @ApiResponse({ status: 404, description: 'MILESTONE_NOT_FOUND' })
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.milestonesService.remove(user, id);
  }
}
