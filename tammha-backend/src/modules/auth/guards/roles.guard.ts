import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';

/**
 * Allowed account roles for a route or a whole controller.
 * Usage: @Roles([UserRole.STUDENT, UserRole.SUPERVISOR])
 * A method-level @Roles overrides a controller-level one.
 */
export const Roles = Reflector.createDecorator<UserRole[]>();

/**
 * Checks request.user.role against @Roles. Must run AFTER JwtAuthGuard:
 * @UseGuards(JwtAuthGuard, RolesGuard)
 * Routes without @Roles are open to any authenticated user.
 * TeamRole (LEADER/MEMBER) is never considered here.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const allowedRoles = this.reflector.getAllAndOverride(Roles, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!allowedRoles || allowedRoles.length === 0) {
      return true;
    }

    const user = context.switchToHttp().getRequest().user;
    return !!user && allowedRoles.includes(user.role);
  }
}
