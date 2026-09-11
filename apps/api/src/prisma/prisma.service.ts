import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { getPrismaClient, type PrismaClient } from '@knowledge-explorer/database';

/**
 * Thin Nest wrapper over the shared Prisma client.
 *
 * Nest's type-based dependency injection needs emitDecoratorMetadata, which
 * esbuild (tsx, vitest) does not produce. Every injection in this app is
 * therefore declared explicitly with @Inject(Token), which needs no metadata.
 */
@Injectable()
export class PrismaService implements OnModuleDestroy {
  readonly client: PrismaClient = getPrismaClient();

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
