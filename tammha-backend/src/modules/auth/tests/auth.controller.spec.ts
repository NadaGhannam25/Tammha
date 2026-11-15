import { Test, TestingModule } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import { AuthController } from '../auth.controller';
import { AuthService } from '../auth.service';
import { UniversityIdentityService } from '../university-identity.service';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { toSafeUser } from '@modules/users/user.mapper';

/**
 * Unit tests for AuthController.
 * AuthService is mocked; the JWT guard is bypassed here
 * (guard behaviour is covered in auth.integration.spec.ts).
 */
describe('AuthController', () => {
  let controller: AuthController;

  const authServiceMock = {
    register: jest.fn(),
    login: jest.fn(),
    refreshAccessToken: jest.fn(),
    logout: jest.fn(),
  };

  const tokens = {
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresIn: 3600,
  };

  const user = {
    id: 'user-1',
    email: 'student@test.local',
    password: 'hashed-password',
    firstName: 'Test',
    lastName: 'Student',
    preferredLanguage: 'ar',
    role: UserRole.STUDENT,
    universityId: 'uni-1',
    avatar: null,
    bio: null,
    studentNumber: null,
    universityEmail: null,
    universityEmailVerifiedAt: null,
    pendingUniversityEmail: null,
    emailVerifiedAt: null,
    onboardingCompletedAt: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: authServiceMock },
        { provide: UniversityIdentityService, useValue: {} },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<AuthController>(AuthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('register delegates to AuthService.register', async () => {
    const dto = {
      email: user.email,
      password: 'Password123',
      role: UserRole.STUDENT,
      universityId: 'uni-1',
    };
    const safeUser = toSafeUser(user);
    authServiceMock.register.mockResolvedValue({ user: safeUser, tokens });

    const result = await controller.register(dto);

    expect(authServiceMock.register).toHaveBeenCalledWith(dto);
    expect(result.tokens).toEqual(tokens);
  });

  it('login delegates to AuthService.login', async () => {
    const dto = { email: user.email, password: 'Password123' };
    authServiceMock.login.mockResolvedValue({ user, tokens });

    await controller.login(dto);

    expect(authServiceMock.login).toHaveBeenCalledWith(dto);
  });

  it('refresh passes only the refresh token string', async () => {
    authServiceMock.refreshAccessToken.mockResolvedValue(tokens);

    const result = await controller.refresh({ refreshToken: 'raw-token' });

    expect(authServiceMock.refreshAccessToken).toHaveBeenCalledWith(
      'raw-token',
    );
    expect(result).toEqual(tokens);
  });

  it('me returns request.user (already password-free from JwtStrategy)', async () => {
    const safeUser = toSafeUser(user);
    const result = await controller.me({ user: safeUser });

    expect(result).toBe(safeUser);
    expect(result).not.toHaveProperty('password');
    expect(result.email).toBe(user.email);
    expect(result.role).toBe(UserRole.STUDENT);
  });

  it('logout revokes tokens for the current user id', async () => {
    authServiceMock.logout.mockResolvedValue({ message: 'Logout successful' });

    const safeUser = toSafeUser(user);
    const result = await controller.logout({ user: safeUser });

    expect(authServiceMock.logout).toHaveBeenCalledWith('user-1');
    expect(result).toEqual({ message: 'Logout successful' });
  });
});
