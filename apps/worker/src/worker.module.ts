import { Module } from '@nestjs/common';
import { REDIS_URL, RedisService } from './redis.service';

@Module({
  providers: [
    { provide: REDIS_URL, useFactory: () => process.env['REDIS_URL'] ?? 'redis://localhost:6380' },
    RedisService,
  ],
})
export class WorkerModule {}
