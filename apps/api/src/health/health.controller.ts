import { Controller, Get, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

interface HealthResponse {
  status: 'ok' | 'degraded';
  database: 'ok' | 'unreachable';
}

@Controller('health')
export class HealthController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Confirms the process is up AND that it can complete a database round trip.
   * P0's non-goals exclude a Redis check and a readiness/liveness split.
   */
  @Get()
  async check(): Promise<HealthResponse> {
    try {
      const rows = await this.prisma.client.$queryRaw<Array<{ ok: number }>>`select 1 as ok`;
      const reachable = Array.isArray(rows) && rows.length === 1 && rows[0]?.ok === 1;
      return { status: reachable ? 'ok' : 'degraded', database: reachable ? 'ok' : 'unreachable' };
    } catch {
      return { status: 'degraded', database: 'unreachable' };
    }
  }
}
