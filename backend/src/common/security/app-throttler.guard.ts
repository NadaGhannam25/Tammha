import {
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ThrottlerGuard, ThrottlerLimitDetail } from '@nestjs/throttler';

/** Same error shape as the rest of the API: 429 { code: 'RATE_LIMITED', details.retryAfterSeconds }. */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const retryAfterSeconds = Math.max(1, Math.ceil(detail.timeToBlockExpire));
    const res = context.switchToHttp().getResponse<{
      header?: (name: string, value: string) => void;
    }>();
    res.header?.('Retry-After', String(retryAfterSeconds));
    throw new HttpException(
      {
        code: 'RATE_LIMITED',
        message: 'Too many requests. Please wait and try again.',
        details: { retryAfterSeconds },
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
