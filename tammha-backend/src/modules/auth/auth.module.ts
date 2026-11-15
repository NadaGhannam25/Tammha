import { Module } from '@nestjs/common';
import { JwtModule, JwtSignOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { AuthTokensService } from './auth-tokens.service';
import { AccountEmailService } from './account-email.service';
import { UniversityIdentityService } from './university-identity.service';
import { SupervisorAccountsService } from './supervisor-accounts.service';
import { AdminSupervisorsController } from './admin-supervisors.controller';
import { PrismaModule } from '@/prisma/prisma.module';
import { UsersModule } from '@modules/users/users.module';
import {
  JWT_ALGORITHM,
  JWT_AUDIENCE,
  JWT_ISSUER,
} from '@/config/security.config';

/**
 * JwtAuthGuard and RolesGuard need no provider registration: they are applied
 * with @UseGuards(JwtAuthGuard, RolesGuard) and instantiated by Nest where used.
 */
@Module({
  imports: [
    PrismaModule,
    UsersModule,
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<string>('JWT_SECRET'),
        signOptions: {
          algorithm: JWT_ALGORITHM,
          issuer: JWT_ISSUER,
          audience: JWT_AUDIENCE,
          expiresIn: configService.get<string>(
            'JWT_EXPIRATION',
            '1h',
          ) as JwtSignOptions['expiresIn'],
        },
        verifyOptions: {
          algorithms: [JWT_ALGORITHM],
          issuer: JWT_ISSUER,
          audience: JWT_AUDIENCE,
        },
      }),
    }),
  ],
  controllers: [AuthController, AdminSupervisorsController],
  providers: [
    AuthService,
    JwtStrategy,
    AuthTokensService,
    AccountEmailService,
    UniversityIdentityService,
    SupervisorAccountsService,
  ],
  exports: [AuthService],
})
export class AuthModule {}
