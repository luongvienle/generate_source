import { Module } from '@nestjs/common';
import { REDIS_URL, RedisService } from './redis.service';
import { ImportWorkerService } from './jobs/import-worker.service';
import { PrismaService } from './prisma.service';

@Module({
  providers: [
    { provide: REDIS_URL, useFactory: () => process.env['REDIS_URL'] ?? 'redis://localhost:6380' },
    RedisService,
    PrismaService,
    ImportWorkerService,
  ],
})
export class WorkerModule {}
