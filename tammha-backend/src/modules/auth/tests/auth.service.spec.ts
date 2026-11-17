import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '@prisma/client';
import { AuthService, hashRefreshToken } from '../auth.service';
import { AuthTokensService } from '../auth-tokens.service';
import { AccountEmailService } from '../account-email.service';
import { UniversityIdentityService } from '../university-identity.service';
import { PrismaService } from '@/prisma/prisma.service';
import { UsersService } from '@modules/users/users.service';
import { RegisterDto } from '../dto/register.dto';

/** Unit tests for AuthService. All collaborators are mocked; no database needed. */
describe('AuthService', () => {
  let service: AuthService;

  const prismaMock = {
    university: { findUnique: jest.fn() },
    refreshToken: {
      create: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const usersServiceMock = {
    findByEmail: jest.fn(),
    findById: jest.fn(),
    create: jest.fn(),
    validatePassword: jest.fn(),
  };
  const jwtServiceMock = { sign: jest.fn(), decode: jest.fn() };
  const configValues: Record<string, string> = {
    BCRYPT_ROUNDS: '4',
    JWT_EXPIRATION: '1h',
  };
  const configServiceMock = {
    get: jest.fn((key: string, def?: string) => configValues[key] ?? def),
  };

  const baseUser = {
    id: 'user-1',
    email: 'student@test.local',
    password: '$2b$04$hashedpasswordplaceholder',
    firstName: 'Test',
    lastName: 'Student',
    role: UserRole.STUDENT,
    universityId: 'uni-1',
    avatar: null,
    bio: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const registerDto: RegisterDto = {
    email: 'student@test.local',
    password: 'Password123',
    firstName: 'Test',
    lastName: 'Student',
    role: UserRole.STUDENT,
    universityId: 'uni-1',
    studentNumber: 'S-001',
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    jwtServiceMock.sign.mockReturnValue('signed.access.token');
    jwtServiceMock.decode.mockReturnValue({ iat: 1000, exp: 4600 });
    prismaMock.university.findUnique.mockResolvedValue({
      id: 'uni-1',
      isActive: true,
    });
    prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 1 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: UsersService, useValue: usersServiceMock },
        { provide: JwtService, useValue: jwtServiceMock },
        { provide: ConfigService, useValue: configServiceMock },
        {
          provide: UniversityIdentityService,
          useValue: {
            resolveForRegistration: jest.fn().mockResolvedValue(null),
            sendAfterRegistration: jest.fn().mockResolvedValue(undefined),
            promoteAccountEmail: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: AuthTokensService,
          useValue: {
            issue: jest.fn().mockResolvedValue('raw-token'),
            issueCode: jest.fn().mockResolvedValue('123456'),
          },
        },
        {
          provide: AccountEmailService,
          useValue: {
            sendVerification: jest.fn().mockResolvedValue(undefined),
            sendVerificationCode: jest.fn().mockResolvedValue(undefined),
            sendPasswordReset: jest.fn().mockResolvedValue(undefined),
            deliveryState: 'NOT_CONFIGURED',
          },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  describe('register', () => {
    it('creates a STUDENT and returns a safe user + tokens', async () => {
      usersServiceMock.findByEmail.mockResolvedValue(null);
      usersServiceMock.create.mockResolvedValue(baseUser);

      const result = await service.register(registerDto);

      expect(result.user).not.toHaveProperty('password');
      expect(result.tokens.accessToken).toBe('signed.access.token');
      expect(result.tokens.refreshToken).toMatch(/^[a-f0-9]{64}$/);
      expect(result.tokens.expiresIn).toBe(3600);
    });

    it('stores only the SHA-256 digest of the refresh token', async () => {
      usersServiceMock.findByEmail.mockResolvedValue(null);
      usersServiceMock.create.mockResolvedValue(baseUser);

      const result = await service.register(registerDto);
      const stored = prismaMock.refreshToken.create.mock.calls[0][0].data;

      expect(stored.tokenHash).toBe(
        hashRefreshToken(result.tokens.refreshToken),
      );
      expect(stored.tokenHash).not.toBe(result.tokens.refreshToken);
      expect(stored.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('SUPERVISOR self-registration needs a university e-mail; a student needs a student ID', async () => {
      const sup = await service
        .register({
          ...registerDto,
          email: 'sup@gmail.com',
          role: UserRole.SUPERVISOR,
        })
        .catch((e) => e);
      expect(sup.getStatus()).toBe(400);
      expect(sup.getResponse().code).toBe(
        'SUPERVISOR_UNIVERSITY_EMAIL_REQUIRED',
      );
      const noNumber = await service
        .register({ ...registerDto, studentNumber: undefined })
        .catch((e) => e);
      expect(noNumber.getResponse().code).toBe('STUDENT_NUMBER_REQUIRED');
      expect(usersServiceMock.create).not.toHaveBeenCalled();
    });

    it('rejects ADMIN registration', async () => {
      await expect(
        service.register({ ...registerDto, role: UserRole.ADMIN }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(usersServiceMock.create).not.toHaveBeenCalled();
    });

    it('rejects an unknown or inactive university with 400 (not a 500 FK error)', async () => {
      prismaMock.university.findUnique.mockResolvedValue(null);
      await expect(service.register(registerDto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      prismaMock.university.findUnique.mockResolvedValue({
        id: 'uni-1',
        isActive: false,
      });
      await expect(service.register(registerDto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(usersServiceMock.create).not.toHaveBeenCalled();
    });

    it('rejects a duplicate email with 409', async () => {
      usersServiceMock.findByEmail.mockResolvedValue(baseUser);
      await expect(service.register(registerDto)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('maps a concurrent duplicate (P2002) to 409', async () => {
      usersServiceMock.findByEmail.mockResolvedValue(null);
      usersServiceMock.create.mockRejectedValue(
        Object.assign(new Error('u'), { code: 'P2002' }),
      );
      await expect(service.register(registerDto)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('login', () => {
    it('returns a safe user + tokens for valid credentials', async () => {
      usersServiceMock.findByEmail.mockResolvedValue(baseUser);
      usersServiceMock.validatePassword.mockResolvedValue(true);

      const result = await service.login({
        email: baseUser.email,
        password: 'Password123',
      });

      expect(result.user).not.toHaveProperty('password');
      expect(jwtServiceMock.sign).toHaveBeenCalledWith(
        { sub: baseUser.id, email: baseUser.email, role: baseUser.role },
        { expiresIn: '1h' },
      );
    });

    it('unknown email still runs a bcrypt comparison, then 401', async () => {
      usersServiceMock.findByEmail.mockResolvedValue(null);
      usersServiceMock.validatePassword.mockResolvedValue(false);

      await expect(
        service.login({ email: 'nobody@test.local', password: 'Password123' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(usersServiceMock.validatePassword).toHaveBeenCalledWith(
        'Password123',
        expect.stringMatching(/^\$2[aby]\$/),
      );
    });

    it('wrong password: 401 and no token issued', async () => {
      usersServiceMock.findByEmail.mockResolvedValue(baseUser);
      usersServiceMock.validatePassword.mockResolvedValue(false);
      await expect(
        service.login({ email: baseUser.email, password: 'WrongPass123' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prismaMock.refreshToken.create).not.toHaveBeenCalled();
    });

    it('inactive user: 401', async () => {
      usersServiceMock.findByEmail.mockResolvedValue({
        ...baseUser,
        isActive: false,
      });
      usersServiceMock.validatePassword.mockResolvedValue(true);
      await expect(
        service.login({ email: baseUser.email, password: 'Password123' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('refreshAccessToken', () => {
    const raw = 'a'.repeat(64);
    const activeRecord = () => ({
      id: 'rt-1',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: baseUser,
    });

    it('looks the token up by its digest, revokes it once and issues a new pair', async () => {
      prismaMock.refreshToken.findUnique.mockResolvedValue(activeRecord());

      const tokens = await service.refreshAccessToken(raw);

      expect(prismaMock.refreshToken.findUnique).toHaveBeenCalledWith({
        where: { tokenHash: hashRefreshToken(raw) },
        include: { user: true },
      });
      expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { id: 'rt-1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      expect(tokens.refreshToken).not.toBe(raw);
    });

    it.each([
      ['unknown', null],
      ['revoked', { revokedAt: new Date() }],
      ['expired', { expiresAt: new Date(Date.now() - 1000) }],
    ])('401 for a %s token', async (_label, patch) => {
      prismaMock.refreshToken.findUnique.mockResolvedValue(
        patch === null ? null : { ...activeRecord(), ...patch },
      );
      await expect(service.refreshAccessToken(raw)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(prismaMock.refreshToken.create).not.toHaveBeenCalled();
    });

    it('401 when a concurrent request already used the token', async () => {
      prismaMock.refreshToken.findUnique.mockResolvedValue(activeRecord());
      prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.refreshAccessToken(raw)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(prismaMock.refreshToken.create).not.toHaveBeenCalled();
    });

    it('401 when the owner is inactive', async () => {
      prismaMock.refreshToken.findUnique.mockResolvedValue({
        ...activeRecord(),
        user: { ...baseUser, isActive: false },
      });
      await expect(service.refreshAccessToken(raw)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('400 for an empty token', async () => {
      await expect(service.refreshAccessToken('')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('logout', () => {
    it('revokes only still-active refresh tokens', async () => {
      const result = await service.logout(baseUser.id);
      expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: baseUser.id, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      expect(result).toEqual({ message: 'Logout successful' });
    });
  });
});
