import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { UniversityIdentityService } from './university-identity.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh.dto';
import {
  RegisterResponseDto,
  LoginResponseDto,
  RefreshResponseDto,
  MeResponseDto,
  AccountMessageDto,
  VerifyEmailResponseDto,
  UniversityEmailRequestResultDto,
  UniversityEmailVerifiedDto,
} from './dto/auth-response.dto';
import {
  ForgotPasswordDto,
  ResetPasswordDto,
  VerifyEmailDto,
  UniversityEmailRequestDto,
  ConfirmAccountDeletionDto,
} from './dto/account.dto';
import { AccountLifecycleService } from './account-lifecycle.service';
import { AllowUnverifiedEmail, JwtAuthGuard } from './guards/jwt-auth.guard';
import { StrictRateLimit } from '@common/security/rate-limit.decorator';
import { AuthenticatedRequest } from '@common/types/auth-user.type';

@Controller('auth')
@ApiTags('Auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly universityIdentity: UniversityIdentityService,
    private readonly lifecycle: AccountLifecycleService,
  ) {}

  @Post('me/password-link')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @StrictRateLimit()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'E-mail me a link to change my password (settings page)',
    description:
      'Sends a reset link to the account e-mail. Within 5 minutes of the last link nothing is sent again: ' +
      'alreadySent=true with retryAfterSeconds.',
  })
  sendPasswordLink(@Request() req: AuthenticatedRequest) {
    return this.lifecycle.sendPasswordLink(req.user);
  }

  @Post('me/delete/request')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @StrictRateLimit()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Start deleting my account: e-mails a 6-digit code',
    description:
      'The code is valid for 15 minutes (5 attempts). 409 ACCOUNT_DELETION_BLOCKED (details.blockers) while the ' +
      'user leads a team that has other members or supervises projects. 429 DELETION_CODE_RECENTLY_SENT.',
  })
  requestDeletion(@Request() req: AuthenticatedRequest) {
    return this.lifecycle.requestDeletion(req.user);
  }

  @Post('me/delete/confirm')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @StrictRateLimit()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete my account permanently with the e-mailed code',
    description:
      'Removes the personal data, signs out every device and disables the account; a goodbye e-mail is sent. ' +
      '400 DELETION_CODE_INVALID, 409 ACCOUNT_DELETION_BLOCKED.',
  })
  confirmDeletion(
    @Request() req: AuthenticatedRequest,
    @Body() dto: ConfirmAccountDeletionDto,
  ) {
    return this.lifecycle.confirmDeletion(req.user, dto.code);
  }

  /**
   * Register a new STUDENT account
   * POST /api/v1/auth/register
   */
  @Post('register')
  @StrictRateLimit()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Register a new student account',
    description:
      'Public self-registration is for STUDENT accounts only. Required: university, student number ' +
      '(student ID) and a university e-mail (the account e-mail on the university domain, or universityEmail). ' +
      'Full access starts after the e-mail verification. Supervisor accounts are created by an ADMIN ' +
      '(POST /admin/supervisors) and activated by e-mail (POST /auth/activate-account).',
  })
  @ApiResponse({
    status: 201,
    description: 'User registered successfully',
    type: RegisterResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Invalid input, STUDENT_NUMBER_REQUIRED, UNIVERSITY_EMAIL_REQUIRED, UNIVERSITY_EMAIL_DOMAIN_MISMATCH, SUPERVISOR_UNIVERSITY_EMAIL_REQUIRED or ADMIN role attempted',
  })
  @ApiResponse({
    status: 409,
    description:
      'Email already registered, STUDENT_NUMBER_TAKEN or UNIVERSITY_EMAIL_TAKEN',
  })
  async register(
    @Body() registerDto: RegisterDto,
  ): Promise<RegisterResponseDto> {
    return this.authService.register(registerDto);
  }

  /**
   * Login with email and password
   * POST /api/v1/auth/login
   */
  @Post('login')
  @StrictRateLimit()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Login user',
    description:
      'Authenticate with email and password. Returns access and refresh tokens.',
  })
  @ApiResponse({
    status: 200,
    description: 'Login successful',
    type: LoginResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid credentials or inactive user',
  })
  async login(@Body() loginDto: LoginDto): Promise<LoginResponseDto> {
    return this.authService.login(loginDto);
  }

  /**
   * Refresh access token using refresh token
   * Implements token rotation: revokes old token, issues new access + refresh token
   * POST /api/v1/auth/refresh
   */
  @Post('refresh')
  @StrictRateLimit()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Refresh access token',
    description:
      'Get a new access token using a refresh token. Implements token rotation: ' +
      'the provided refresh token is revoked and a new refresh token is issued.',
  })
  @ApiResponse({
    status: 200,
    description: 'Tokens refreshed successfully',
    type: RefreshResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Refresh token is missing',
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid or expired refresh token',
  })
  async refresh(
    @Body() refreshDto: RefreshTokenDto,
  ): Promise<RefreshResponseDto> {
    return this.authService.refreshAccessToken(refreshDto.refreshToken);
  }

  /**
   * Get current user details
   * GET /api/v1/auth/me
   * Requires valid JWT access token
   */
  @Get('me')
  @AllowUnverifiedEmail()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @ApiOperation({
    summary: 'Get current user',
    description: 'Retrieve the current authenticated user details',
  })
  @ApiResponse({
    status: 200,
    description: 'Current user details',
    type: MeResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized - invalid or missing JWT token',
  })
  async me(@Request() req: AuthenticatedRequest): Promise<MeResponseDto> {
    // JwtStrategy already removed the password hash
    return req.user;
  }

  /**
   * Logout user
   * POST /api/v1/auth/logout
   * Requires valid JWT access token
   */
  @Post('logout')
  @AllowUnverifiedEmail()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Logout user',
    description: 'Revoke all active refresh tokens for the current user',
  })
  @ApiResponse({
    status: 200,
    description: 'Logout successful',
    schema: { example: { message: 'Logout successful' } },
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized - invalid or missing JWT token',
  })
  async logout(
    @Request() req: AuthenticatedRequest,
  ): Promise<{ message: string }> {
    return this.authService.logout(req.user.id);
  }

  // ==========================================================
  // P16: e-mail verification and password reset
  // ==========================================================

  @Post('verify-email')
  @StrictRateLimit()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify the e-mail address (token from the verification link)',
    description:
      'Public. The frontend page /verify-email?token=... posts the token here. Tokens are single-use and expire after 24 hours.',
  })
  @ApiResponse({ status: 200, type: VerifyEmailResponseDto })
  @ApiResponse({
    status: 400,
    description: 'VERIFICATION_TOKEN_INVALID (unknown, used or expired)',
  })
  verifyEmail(@Body() dto: VerifyEmailDto): Promise<VerifyEmailResponseDto> {
    return this.authService.verifyEmail(dto.token);
  }

  @Post('resend-verification')
  @AllowUnverifiedEmail()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @StrictRateLimit()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send a new verification link to the signed-in user',
    description:
      'Older links stop working. At most one e-mail per minute. `emailDelivery` says whether this server can send e-mails.',
  })
  @ApiResponse({ status: 200, type: AccountMessageDto })
  @ApiResponse({ status: 409, description: 'EMAIL_ALREADY_VERIFIED' })
  @ApiResponse({
    status: 429,
    description: 'VERIFICATION_RECENTLY_SENT (details.retryAfterSeconds)',
  })
  resendVerification(
    @Request() req: AuthenticatedRequest,
  ): Promise<AccountMessageDto> {
    return this.authService.resendVerification(req.user.id);
  }

  @Post('university-email')
  @UseGuards(JwtAuthGuard)
  @AllowUnverifiedEmail() // needed to reach full access when it is not verified yet
  @ApiBearerAuth('jwt')
  @StrictRateLimit()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Add or replace my university e-mail (STUDENT)',
    description:
      'Full access needs a verified university e-mail. A verification link is sent to ' +
      'the address (it counts only after the link is used). When it is the already-verified account e-mail, ' +
      'it is verified at once. Validated against the university e-mail domains when configured. ' +
      'At most one link per minute.',
  })
  @ApiResponse({ status: 200, type: UniversityEmailRequestResultDto })
  @ApiResponse({
    status: 400,
    description:
      'UNIVERSITY_EMAIL_NOT_ALLOWED (not a student), UNIVERSITY_EMAIL_DOMAIN_MISMATCH or validation errors',
  })
  @ApiResponse({
    status: 409,
    description: 'UNIVERSITY_EMAIL_TAKEN or UNIVERSITY_EMAIL_ALREADY_VERIFIED',
  })
  @ApiResponse({ status: 429, description: 'VERIFICATION_RECENTLY_SENT' })
  requestUniversityEmail(
    @Request() req: AuthenticatedRequest,
    @Body() dto: UniversityEmailRequestDto,
  ) {
    return this.universityIdentity.request(req.user, dto.universityEmail);
  }

  @Post('verify-university-email')
  @StrictRateLimit()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify the university e-mail (token from its link)',
    description:
      'Public. The frontend page /verify-university-email?token=... posts the token here. Single use, 24 hours. ' +
      'If the address is also the account e-mail, the account e-mail is verified too.',
  })
  @ApiResponse({ status: 200, type: UniversityEmailVerifiedDto })
  @ApiResponse({
    status: 400,
    description:
      'VERIFICATION_TOKEN_INVALID (unknown, used, expired or replaced by a newer request)',
  })
  @ApiResponse({ status: 409, description: 'UNIVERSITY_EMAIL_TAKEN' })
  verifyUniversityEmail(@Body() dto: VerifyEmailDto) {
    return this.universityIdentity.verify(dto.token);
  }

  @Post('forgot-password')
  @StrictRateLimit()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Request a password reset link',
    description:
      'Public. Always answers 200 with the same message, whether or not the e-mail belongs to an account. The link is valid for 30 minutes.',
  })
  @ApiResponse({ status: 200, type: AccountMessageDto })
  forgotPassword(@Body() dto: ForgotPasswordDto): Promise<AccountMessageDto> {
    return this.authService.forgotPassword(dto.email);
  }

  @Post('reset-password')
  @StrictRateLimit()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Set a new password with a reset token',
    description:
      'Public. The token is single-use. All refresh tokens of the user are revoked, so every device signs in again.',
  })
  @ApiResponse({
    status: 200,
    schema: {
      example: {
        message: 'Your password has been changed. Please sign in again.',
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'RESET_TOKEN_INVALID or a password that breaks the policy',
  })
  resetPassword(@Body() dto: ResetPasswordDto): Promise<{ message: string }> {
    return this.authService.resetPassword(dto.token, dto.newPassword);
  }

  @Post('activate-account')
  @StrictRateLimit()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Activate a supervisor account (choose the first password)',
    description:
      'Public. The ADMIN-created supervisor receives a link (/activate-account?token=...). Single use, 7 days. ' +
      'Activating also verifies the e-mail address.',
  })
  @ApiResponse({
    status: 200,
    schema: {
      example: { message: 'Your account is active. You can sign in now.' },
    },
  })
  @ApiResponse({
    status: 400,
    description:
      'ACTIVATION_TOKEN_INVALID or a password that breaks the policy',
  })
  activateAccount(@Body() dto: ResetPasswordDto): Promise<{ message: string }> {
    return this.authService.activateAccount(dto.token, dto.newPassword);
  }
}
