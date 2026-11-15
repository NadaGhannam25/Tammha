import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '@/prisma/prisma.service';
import { emailEquals } from '@common/utils/email.util';
import { SafeUser, toSafeUser } from './user.mapper';

@Injectable()
export class UsersService {
  private readonly bcryptRounds: number;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    this.bcryptRounds = parseInt(
      configService.get<string>('BCRYPT_ROUNDS', '10'),
      10,
    );
  }

  /** Creates a user with a bcrypt-hashed password (cost = BCRYPT_ROUNDS). */
  async create(userData: {
    email: string;
    password: string;
    firstName?: string;
    lastName?: string;
    role: UserRole;
    universityId: string;
    studentNumber?: string | null;
    preferredLanguage?: 'ar' | 'en';
    pendingUniversityEmail?: string | null;
  }) {
    const hashedPassword = await bcrypt.hash(
      userData.password,
      this.bcryptRounds,
    );

    return this.prisma.user.create({
      data: {
        email: userData.email,
        password: hashedPassword,
        firstName: userData.firstName,
        lastName: userData.lastName,
        preferredLanguage: userData.preferredLanguage ?? 'ar',
        role: userData.role,
        universityId: userData.universityId,
        studentNumber: userData.studentNumber ?? null,
        pendingUniversityEmail: userData.pendingUniversityEmail ?? null,
      },
    });
  }

  /** bcrypt hash with the configured cost (BCRYPT_ROUNDS). */
  hashPassword(plain: string): Promise<string> {
    return bcrypt.hash(plain, this.bcryptRounds);
  }

  /** Full record by id (includes the password hash — internal use only). */
  async findById(id: string) {
    return this.prisma.user.findUnique({ where: { id } });
  }

  /** Full record by email, case-insensitive (includes the password hash — internal use only). */
  async findByEmail(email: string) {
    return this.prisma.user.findFirst({ where: emailEquals(email) });
  }

  async validatePassword(
    plainPassword: string,
    hashedPassword: string,
  ): Promise<boolean> {
    return bcrypt.compare(plainPassword, hashedPassword);
  }

  /** Public-safe profile (no password). */
  async getUserProfile(id: string): Promise<SafeUser> {
    const user = await this.findById(id);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return toSafeUser(user);
  }

  async updateProfile(
    id: string,
    updateData: {
      firstName?: string;
      lastName?: string;
      avatar?: string;
      bio?: string;
      preferredLanguage?: 'ar' | 'en';
    },
  ): Promise<SafeUser> {
    const user = await this.prisma.user.update({
      where: { id },
      data: updateData,
    });
    return toSafeUser(user);
  }
}
