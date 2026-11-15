import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuthTokenType, User, UserRole } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '@/prisma/prisma.service';
import { isUniqueConstraintError } from '@common/utils/prisma-errors.util';
import { emailDomainAllowed } from '@common/identity/university-email';
import { UsersService } from '@modules/users/users.service';
import { AuthTokensService } from './auth-tokens.service';
import { AccountEmailService } from './account-email.service';
import {
  CreateSupervisorDto,
  SupervisorAccountDto,
} from './dto/supervisor-account.dto';

/**
 * Supervisor accounts are never self-registered. An ADMIN creates them; the account
 * starts with an unusable random password and the supervisor chooses the first password
 * through the e-mailed activation link (POST /auth/activate-account), which also
 * verifies the e-mail address.
 */
@Injectable()
export class SupervisorAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly tokens: AuthTokensService,
    private readonly accountEmail: AccountEmailService,
  ) {}

  async create(dto: CreateSupervisorDto): Promise<SupervisorAccountDto> {
    const university = await this.prisma.university.findUnique({
      where: { id: dto.universityId },
      select: { id: true, isActive: true, emailDomains: true },
    });
    if (!university?.isActive) {
      throw new BadRequestException({
        code: 'UNIVERSITY_NOT_FOUND',
        message: 'universityId does not match an active university',
      });
    }
    if (!emailDomainAllowed(dto.email, university.emailDomains)) {
      throw new BadRequestException({
        code: 'SUPERVISOR_EMAIL_DOMAIN_MISMATCH',
        message:
          "The supervisor's e-mail must be a university address of this university",
        details: { allowedDomains: university.emailDomains },
      });
    }
    let user: User;
    try {
      user = await this.users.create({
        email: dto.email,
        // unusable until activation: nobody knows this value
        password: randomBytes(32).toString('base64url'),
        firstName: dto.firstName,
        lastName: dto.lastName,
        role: UserRole.SUPERVISOR,
        universityId: university.id,
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException({
          code: 'EMAIL_ALREADY_REGISTERED',
          message: 'An account with this e-mail already exists',
        });
      }
      throw error;
    }
    await this.sendActivation(user);
    return this.view(user);
  }

  /** A new activation link (the previous unused ones stop working). */
  async resendActivation(userId: string): Promise<SupervisorAccountDto> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.role !== UserRole.SUPERVISOR) {
      throw new NotFoundException({
        code: 'SUPERVISOR_NOT_FOUND',
        message: 'Supervisor account not found',
      });
    }
    if (user.emailVerifiedAt) {
      throw new ConflictException({
        code: 'ACCOUNT_ALREADY_ACTIVE',
        message:
          'This account is already active. The supervisor can use "Forgot password".',
      });
    }
    await this.sendActivation(user);
    return this.view(user);
  }

  private async sendActivation(user: User) {
    await this.prisma.authToken.updateMany({
      where: {
        userId: user.id,
        type: AuthTokenType.ACCOUNT_ACTIVATION,
        usedAt: null,
      },
      data: { usedAt: new Date() },
    });
    const token = await this.tokens.issue(
      user.id,
      AuthTokenType.ACCOUNT_ACTIVATION,
    );
    await this.accountEmail.sendAccountActivation(
      user.email,
      user.firstName,
      token,
      user.preferredLanguage,
    );
  }

  private view(user: User): SupervisorAccountDto {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      universityId: user.universityId!,
      activated: !!user.emailVerifiedAt,
      emailDelivery: this.accountEmail.deliveryState,
    };
  }
}
