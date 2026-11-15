import { Controller, Get } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { Roles, RolesGuard } from '../guards/roles.guard';

@Controller()
@Roles([UserRole.SUPERVISOR])
class ClassLevelController {
  @Get() inherit() {}
  @Get() @Roles([UserRole.STUDENT]) override() {}
}

class OpenController {
  open() {}
}

describe('RolesGuard', () => {
  const guard = new RolesGuard(new Reflector());

  const ctx = (cls: any, handler: string, role?: UserRole) =>
    ({
      getClass: () => cls,
      getHandler: () => cls.prototype[handler],
      switchToHttp: () => ({
        getRequest: () => ({ user: role ? { role } : undefined }),
      }),
    }) as any;

  it('applies a controller-level @Roles (previously ignored)', () => {
    expect(
      guard.canActivate(
        ctx(ClassLevelController, 'inherit', UserRole.SUPERVISOR),
      ),
    ).toBe(true);
    expect(
      guard.canActivate(ctx(ClassLevelController, 'inherit', UserRole.STUDENT)),
    ).toBe(false);
  });

  it('a method-level @Roles overrides the controller-level one', () => {
    expect(
      guard.canActivate(
        ctx(ClassLevelController, 'override', UserRole.STUDENT),
      ),
    ).toBe(true);
    expect(
      guard.canActivate(
        ctx(ClassLevelController, 'override', UserRole.SUPERVISOR),
      ),
    ).toBe(false);
  });

  it('allows any authenticated user when no @Roles is set', () => {
    expect(guard.canActivate(ctx(OpenController, 'open', UserRole.ADMIN))).toBe(
      true,
    );
  });

  it('denies when there is no user on the request', () => {
    expect(guard.canActivate(ctx(ClassLevelController, 'inherit'))).toBe(false);
  });
});
