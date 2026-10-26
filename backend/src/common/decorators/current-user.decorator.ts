import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthUser } from '@common/types/auth-user.type';

/**
 * Injects the authenticated user (request.user) into a route handler.
 * Use only on routes protected by JwtAuthGuard.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
