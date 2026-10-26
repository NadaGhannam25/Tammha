import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';

@Injectable()
export class AppService {
  private readonly startTime = Date.now();
  private readonly logger = new Logger(AppService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getHealth() {
    let databaseStatus = 'disconnected';

    try {
      // Test database connection
      await this.prisma.$queryRaw`SELECT 1`;
      databaseStatus = 'connected';
    } catch (error) {
      // Name/code only: driver messages can contain the database host or user
      const e = error as { name?: string; code?: string; errorCode?: string };
      this.logger.warn(
        `Database health check failed (${e?.name ?? 'Error'}${e?.errorCode || e?.code ? ` ${e.errorCode ?? e.code}` : ''})`,
      );
    }

    const uptime = (Date.now() - this.startTime) / 1000; // in seconds

    return {
      status: databaseStatus === 'connected' ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime: parseFloat(uptime.toFixed(2)),
      database: databaseStatus,
    };
  }
}
