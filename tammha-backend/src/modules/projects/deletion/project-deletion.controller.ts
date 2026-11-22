import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
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
import { StrictRateLimit } from '@common/security/rate-limit.decorator';
import { ConfirmAccountDeletionDto } from '@modules/auth/dto/account.dto';
import { ProjectDeletionService } from './project-deletion.service';

@Controller('projects')
@ApiTags('Projects')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiResponse({ status: 401, description: 'Missing or invalid access token' })
export class ProjectDeletionController {
  constructor(private readonly deletion: ProjectDeletionService) {}

  @Post(':id/deletion/request')
  @Roles([UserRole.STUDENT])
  @StrictRateLimit()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'E-mail a code that confirms deleting the project (project owner)',
    description:
      'Only the project owner (the team LEADER). The 6-digit code is valid for 15 minutes, for this project only. ' +
      '403 NOT_TEAM_LEADER, 429 DELETION_CODE_RECENTLY_SENT.',
  })
  @ApiOkResponse({ description: '{ sent, expiresInSeconds, emailDelivery }' })
  request(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.deletion.request(user, id);
  }

  @Post(':id/deletion/confirm')
  @Roles([UserRole.STUDENT])
  @StrictRateLimit()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete the project permanently with the e-mailed code (project owner)',
    description:
      'Deletes the project and its team with every stage, task, file, meeting and AI record; ' +
      'the stored files are removed; every student of the team receives an e-mail. ' +
      '400 DELETION_CODE_INVALID, 403 NOT_TEAM_LEADER.',
  })
  @ApiOkResponse({ description: '{ deleted: true }' })
  confirm(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ConfirmAccountDeletionDto,
  ) {
    return this.deletion.confirm(user, id, dto.code);
  }
}
