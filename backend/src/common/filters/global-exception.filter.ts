import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';

/** Prisma errors that are client mistakes, not server failures. */
const PRISMA_ERROR_MAP: Record<
  string,
  { status: number; code: string; message: string }
> = {
  P2002: {
    status: HttpStatus.CONFLICT,
    code: 'DUPLICATE_VALUE',
    message: 'A record with this value already exists',
  },
  P2003: {
    status: HttpStatus.BAD_REQUEST,
    code: 'RELATED_RECORD_NOT_FOUND',
    message: 'A related record does not exist',
  },
  P2025: {
    status: HttpStatus.NOT_FOUND,
    code: 'RECORD_NOT_FOUND',
    message: 'Record not found',
  },
};

/**
 * One error format for the whole API:
 * { statusCode, timestamp, path, code?, message, details? }
 *
 * - HttpException: its status + message (+ optional machine-readable `code`)
 * - Known Prisma errors: mapped to 409 / 400 / 404
 * - Anything else: 500 with a generic message. Details are logged, never returned.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Internal server error';
    let code: string | undefined;
    let details: Record<string, unknown> | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'object' && body !== null) {
        const b = body as {
          message?: string | string[];
          code?: unknown;
          details?: unknown;
        };
        message = b.message ?? exception.message;
        if (typeof b.code === 'string') code = b.code;
        // P12: optional machine-readable context of a business error (4xx only)
        if (
          status < 500 &&
          typeof b.code === 'string' &&
          b.details &&
          typeof b.details === 'object' &&
          !Array.isArray(b.details)
        ) {
          details = b.details as Record<string, unknown>;
        }
      } else {
        message = String(body);
      }
    } else if (
      exception instanceof Prisma.PrismaClientKnownRequestError &&
      PRISMA_ERROR_MAP[exception.code]
    ) {
      ({ status, code, message } = PRISMA_ERROR_MAP[exception.code]);
    } else if (isClientHttpError(exception)) {
      // Errors raised by Express middleware before Nest (body-parser): e.g. a JSON
      // body over the size limit. Keep their 4xx status instead of reporting a 500.
      status = exception.status;
      message =
        status === HttpStatus.PAYLOAD_TOO_LARGE
          ? 'Request body too large'
          : exception.message;
    }

    if (status === HttpStatus.PAYLOAD_TOO_LARGE && !code) {
      // multer reports an oversized upload as "File too large"
      code =
        message === 'File too large' ? 'FILE_TOO_LARGE' : 'PAYLOAD_TOO_LARGE';
    }

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} -> ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).json({
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      ...(code && { code }),
      message,
      ...(details && { details }),
    });
  }
}

/** http-errors style client errors (status 4xx, expose: true), as thrown by body-parser. */
function isClientHttpError(
  exception: unknown,
): exception is { status: number; message: string } {
  if (typeof exception !== 'object' || exception === null) return false;
  const e = exception as {
    status?: unknown;
    expose?: unknown;
    message?: unknown;
  };
  return (
    typeof e.status === 'number' &&
    e.status >= 400 &&
    e.status < 500 &&
    e.expose === true &&
    typeof e.message === 'string'
  );
}
