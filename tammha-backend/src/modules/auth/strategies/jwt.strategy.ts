import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { JwtPayload } from '../interfaces/jwt-payload.interface';
import { UsersService } from '@modules/users/users.service';
import { toSafeUser } from '@modules/users/user.mapper';
import { AuthUser } from '@common/types/auth-user.type';
import {
  JWT_ALGORITHM,
  JWT_AUDIENCE,
  JWT_ISSUER,
} from '@/config/security.config';

/**
 * Verifies the Bearer access token, then reloads the user from the database so
 * role / active-status changes take effect immediately.
 * request.user never contains the password hash.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private readonly usersService: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('JWT_SECRET'),
      // Pinned: rejects alg "none", RS/HS confusion and tokens minted for another app
      algorithms: [JWT_ALGORITHM],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
  }

  async validate(payload: JwtPayload): Promise<AuthUser> {
    if (typeof payload?.sub !== 'string' || !payload.sub) {
      throw new UnauthorizedException('Invalid token');
    }
    const user = await this.usersService.findById(payload.sub);
    if (!user) {
      throw new UnauthorizedException('User not found');
    }
    if (!user.isActive) {
      throw new UnauthorizedException('User account is inactive');
    }
    return toSafeUser(user);
  }
}
