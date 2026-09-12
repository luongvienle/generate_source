import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { getPrismaClient, type PrismaClient } from '@knowledge-explorer/database';

/**
 * The worker's Prisma client. Mirrors apps/api's service rather than sharing it:
 * §11 makes the two separate deployables, and neither may import the other.
 */
@Injectable()
export class PrismaService implements OnModuleDestroy {
  readonly client: PrismaClient = getPrismaClient();

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
