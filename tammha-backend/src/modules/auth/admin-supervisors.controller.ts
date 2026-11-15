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
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { Roles, RolesGuard } from './guards/roles.guard';
import { SupervisorAccountsService } from './supervisor-accounts.service';
import {
  CreateSupervisorDto,
  SupervisorAccountDto,
} from './dto/supervisor-account.dto';

@Controller('admin/supervisors')
@ApiTags('Admin - Supervisors')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles([UserRole.ADMIN])
@ApiResponse({ status: 401, description: 'Missing or invalid access token' })
@ApiResponse({ status: 403, description: 'ADMIN only' })
export class AdminSupervisorsController {
  constructor(private readonly supervisors: SupervisorAccountsService) {}

  @Post()
  @ApiOperation({
    summary: 'Create a supervisor account (ADMIN)',
    description:
      'Supervisors cannot register themselves. The account is created here and the supervisor receives ' +
      'an activation link (7 days) to choose a password (POST /auth/activate-account).',
  })
  @ApiCreatedResponse({ type: SupervisorAccountDto })
  @ApiResponse({
    status: 400,
    description:
      'UNIVERSITY_NOT_FOUND, SUPERVISOR_EMAIL_DOMAIN_MISMATCH or validation errors',
  })
  @ApiResponse({ status: 409, description: 'EMAIL_ALREADY_REGISTERED' })
  create(@Body() dto: CreateSupervisorDto) {
    return this.supervisors.create(dto);
  }

  @Post(':id/activation')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send a new activation link (ADMIN)' })
  @ApiOkResponse({ type: SupervisorAccountDto })
  @ApiResponse({ status: 404, description: 'SUPERVISOR_NOT_FOUND' })
  @ApiResponse({ status: 409, description: 'ACCOUNT_ALREADY_ACTIVE' })
  resend(@Param('id') id: string) {
    return this.supervisors.resendActivation(id);
  }
}
