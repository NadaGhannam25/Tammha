import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { UsersService } from './users.service';
import { PrismaService } from '@/prisma/prisma.service';

/** Unit tests for UsersService (Prisma mocked). */
describe('UsersService', () => {
  let service: UsersService;

  const prismaMock = {
    user: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
  };

  const user = {
    id: 'user-1',
    email: 'student@test.local',
    password: 'hashed-password',
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

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: prismaMock },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, def?: string) =>
              key === 'BCRYPT_ROUNDS' ? '5' : def,
          },
        },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  it('create hashes the password using BCRYPT_ROUNDS', async () => {
    prismaMock.user.create.mockImplementation(async ({ data }) => ({
      ...user,
      ...data,
    }));

    await service.create({
      email: 'new@test.local',
      password: 'Password123',
      role: UserRole.SUPERVISOR,
      universityId: 'uni-1',
    });

    const saved = prismaMock.user.create.mock.calls[0][0].data;
    expect(saved.password).toMatch(/^\$2[aby]\$05\$/);
    await expect(bcrypt.compare('Password123', saved.password)).resolves.toBe(
      true,
    );
    expect(saved.role).toBe(UserRole.SUPERVISOR);
  });

  it('findById queries by id', async () => {
    prismaMock.user.findUnique.mockResolvedValue(user);
    await expect(service.findById('user-1')).resolves.toEqual(user);
    expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
    });
  });

  it('findByEmail is case-insensitive', async () => {
    prismaMock.user.findFirst.mockResolvedValue(user);
    await service.findByEmail(' Student@Test.Local ');
    expect(prismaMock.user.findFirst).toHaveBeenCalledWith({
      where: { email: { equals: 'Student@Test.Local', mode: 'insensitive' } },
    });
  });

  it('validatePassword compares with bcrypt', async () => {
    const hash = await bcrypt.hash('Password123', 4);
    await expect(service.validatePassword('Password123', hash)).resolves.toBe(
      true,
    );
    await expect(service.validatePassword('wrong-pass', hash)).resolves.toBe(
      false,
    );
  });

  it('getUserProfile never returns the password; 404 when missing', async () => {
    prismaMock.user.findUnique.mockResolvedValue(user);
    await expect(service.getUserProfile('user-1')).resolves.not.toHaveProperty(
      'password',
    );
    prismaMock.user.findUnique.mockResolvedValue(null);
    await expect(service.getUserProfile('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('updateProfile updates only the given fields and hides the password', async () => {
    prismaMock.user.update.mockResolvedValue({ ...user, bio: 'Hello' });
    const result = await service.updateProfile('user-1', { bio: 'Hello' });
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { bio: 'Hello' },
    });
    expect(result).not.toHaveProperty('password');
  });
});
