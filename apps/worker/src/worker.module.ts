import { Module } from '@nestjs/common';
import { REDIS_URL, RedisService } from './redis.service';
import { ImportWorkerService } from './jobs/import-worker.service';
import { ImageWorkerService } from './jobs/image-worker.service';
import { NarrationWorkerService } from './jobs/narration-worker.service';
import { PrismaService } from './prisma.service';
import { OBJECT_STORAGE, S3ObjectStorage, s3ConfigFromEnv } from '@knowledge-explorer/storage';

@Module({
  providers: [
    { provide: REDIS_URL, useFactory: () => process.env['REDIS_URL'] ?? 'redis://localhost:6380' },
    RedisService,
    PrismaService,
    ImportWorkerService,
    ImageWorkerService,
    NarrationWorkerService,
    { provide: OBJECT_STORAGE, useFactory: () => new S3ObjectStorage(s3ConfigFromEnv()) },
  ],
})
export class WorkerModule {}
