import {
  ConflictException,
  HttpStatus,
  PayloadTooLargeException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { GlobalExceptionFilter } from './global-exception.filter';

describe('GlobalExceptionFilter', () => {
  const filter = new GlobalExceptionFilter();

  function run(exception: unknown) {
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => ({ url: '/api/v1/x', method: 'GET' }),
      }),
    } as any;
    jest
      .spyOn((filter as any).logger, 'error')
      .mockImplementation(() => undefined);
    filter.catch(exception, host);
    return {
      status: (status.mock.calls[0] as unknown[])[0],
      body: json.mock.calls[0][0],
    };
  }

  it('keeps HttpException status, message and custom code', () => {
    const { status, body } = run(
      new ConflictException({ code: 'TEAM_FULL', message: 'Full' }),
    );
    expect(status).toBe(409);
    expect(body).toMatchObject({
      statusCode: 409,
      code: 'TEAM_FULL',
      message: 'Full',
      path: '/api/v1/x',
    });
  });

  it('passes details of a coded 4xx business error; nothing else (P12)', () => {
    const opensAt = '2026-11-02T08:45:00.000Z';
    const { body } = run(
      new ConflictException({
        code: 'MEETING_NOT_OPEN_YET',
        message: 'Not open',
        details: { opensAt },
      }),
    );
    expect(body.details).toEqual({ opensAt });
    // no code -> no details; arrays are ignored; no details on plain errors
    expect(
      run(new ConflictException({ message: 'x', details: { a: 1 } })).body
        .details,
    ).toBeUndefined();
    expect(
      run(new ConflictException({ code: 'C', message: 'x', details: [1] })).body
        .details,
    ).toBeUndefined();
    expect(
      run(new ConflictException({ code: 'TEAM_FULL', message: 'Full' })).body,
    ).not.toHaveProperty('details');
  });

  it.each([
    ['P2002', HttpStatus.CONFLICT, 'DUPLICATE_VALUE'],
    ['P2003', HttpStatus.BAD_REQUEST, 'RELATED_RECORD_NOT_FOUND'],
    ['P2025', HttpStatus.NOT_FOUND, 'RECORD_NOT_FOUND'],
  ])('maps Prisma %s', (prismaCode, httpStatus, code) => {
    const error = new Prisma.PrismaClientKnownRequestError('db detail', {
      code: prismaCode,
      clientVersion: 'test',
    });
    const { status, body } = run(error);
    expect(status).toBe(httpStatus);
    expect(body.code).toBe(code);
    expect(body.message).not.toContain('db detail');
  });

  it('hides internal error details behind a generic 500 (no stack, no message)', () => {
    const { status, body } = run(
      new Error('connection string postgres://secret'),
    );
    expect(status).toBe(500);
    expect(body.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(body).not.toHaveProperty('details');
  });

  it('keeps the 413 of an oversized JSON body (body-parser) instead of a 500', () => {
    const bodyParserError = Object.assign(
      new Error('request entity too large'),
      {
        status: 413,
        statusCode: 413,
        expose: true,
        type: 'entity.too.large',
      },
    );
    const { status, body } = run(bodyParserError);
    expect(status).toBe(413);
    expect(body).toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Request body too large',
    });
  });

  it('labels an oversized upload (multer) FILE_TOO_LARGE', () => {
    const { status, body } = run(
      new PayloadTooLargeException('File too large'),
    );
    expect(status).toBe(413);
    expect(body.code).toBe('FILE_TOO_LARGE');
  });

  it('does not trust non-exposed errors that carry a status', () => {
    const internal = Object.assign(new Error('secret internal detail'), {
      status: 400,
      expose: false,
    });
    const { status, body } = run(internal);
    expect(status).toBe(500);
    expect(body.message).toBe('Internal server error');
  });
});
