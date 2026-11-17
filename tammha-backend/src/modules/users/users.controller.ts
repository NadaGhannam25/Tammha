import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
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
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '@modules/auth/guards/roles.guard';
import { MeResponseDto } from '@modules/auth/dto/auth-response.dto';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { AuthUser } from '@common/types/auth-user.type';
import { StrictRateLimit } from '@common/security/rate-limit.decorator';
import { AccountService } from './account.service';
import { StorageQuotaService } from '@modules/storage/storage-quota.service';
import { StorageUsageDto } from '@modules/storage/dto/storage-usage.dto';
import {
  OnboardingStateDto,
  StudentSearchQueryDto,
  StudentSearchResultDto,
  UpdateMyProfileDto,
} from './dto/account.dto';

/** P16: the signed-in user's own account. */
@Controller('users')
@ApiTags('Users')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles([UserRole.STUDENT, UserRole.SUPERVISOR, UserRole.ADMIN])
@ApiResponse({ status: 401, description: 'Missing or invalid access token' })
export class UsersController {
  constructor(
    private readonly account: AccountService,
    private readonly quota: StorageQuotaService,
  ) {}

  @Patch('me')
  @ApiOperation({
    summary:
      'Update my profile (name, bio, photo, student number, preferred language)',
    description:
      'studentNumber is for STUDENT accounts only and is unique within the university. A student must keep a ' +
      'student number or a verified university e-mail (POST /auth/university-email).',
  })
  @ApiOkResponse({ type: MeResponseDto })
  @ApiResponse({
    status: 400,
    description:
      'STUDENT_NUMBER_NOT_ALLOWED, UNIVERSITY_IDENTITY_REQUIRED (removing the only identifier) or validation errors',
  })
  @ApiResponse({ status: 409, description: 'STUDENT_NUMBER_TAKEN' })
  updateMe(@CurrentUser() user: AuthUser, @Body() dto: UpdateMyProfileDto) {
    return this.account.updateMyProfile(user, dto);
  }

  @Get('me/storage')
  @ApiOperation({
    summary: 'My storage usage and quota (all my projects together)',
    description:
      'Students share ONE quota (STUDENT_STORAGE_QUOTA_GB, default 10 GB = 10 × 1024³ bytes) across all their ' +
      'projects. Counts every stored object they uploaded: document files, every document version and project ' +
      'handbook PDFs. `status`: NORMAL, WARNING (≥ 80%), CRITICAL (≥ 95%), FULL (uploads that add data are refused ' +
      'with 409 STORAGE_QUOTA_EXCEEDED; viewing, downloading and deleting still work). Supervisors/admins: NOT_LIMITED.',
  })
  @ApiOkResponse({ type: StorageUsageDto })
  storage(@CurrentUser() user: AuthUser) {
    return this.quota.summary(user);
  }

  @Post('me/onboarding/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark the first-login onboarding as completed',
    description:
      'Idempotent. Stored on the account, so onboarding is not shown again on any device (see `onboardingCompleted` in /auth/me).',
  })
  @ApiOkResponse({ type: OnboardingStateDto })
  completeOnboarding(@CurrentUser() user: AuthUser) {
    return this.account.completeOnboarding(user);
  }
}

/** P16: find a classmate by student number to invite them. */
@Controller('students')
@ApiTags('Users')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles([UserRole.STUDENT])
export class StudentsController {
  constructor(private readonly account: AccountService) {}

  @Get('search')
  @StrictRateLimit()
  @ApiOperation({
    summary:
      'Find a student of my university by student number or university e-mail',
    description:
      'Exactly one of `studentNumber` or `universityEmail` (verified addresses only). Exact match. Returns display ' +
      'name, university, the matched identifier (masked) and whether the student can be invited — never the user ' +
      'id, account e-mail or full identifiers. Rate limited.',
  })
  @ApiResponse({
    status: 400,
    description:
      'STUDENT_IDENTIFIER_REQUIRED (none or both given) or validation errors',
  })
  @ApiOkResponse({ type: StudentSearchResultDto })
  @ApiResponse({ status: 403, description: 'STUDENT accounts only' })
  @ApiResponse({ status: 404, description: 'STUDENT_NOT_FOUND' })
  search(@CurrentUser() user: AuthUser, @Query() query: StudentSearchQueryDto) {
    return this.account.searchStudent(user, query);
  }
}
