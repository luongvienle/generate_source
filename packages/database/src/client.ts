import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

export { PrismaClient };

/**
 * Prisma 7 requires a driver adapter; the connection string no longer lives in
 * the schema. Callers are responsible for loading their own environment —
 * this package reads process.env and never loads a .env file itself.
 */
export function createPrismaClient(connectionString?: string): PrismaClient {
  const url = connectionString ?? process.env['DATABASE_URL'];
  if (!url) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env at the repository root.');
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

const globalForPrisma = globalThis as unknown as { knowledgeExplorerPrisma?: PrismaClient };

/**
 * Memoized on globalThis so a dev server's hot reloads reuse one client instead
 * of opening a new connection pool per reload.
 */
export function getPrismaClient(): PrismaClient {
  globalForPrisma.knowledgeExplorerPrisma ??= createPrismaClient();
  return globalForPrisma.knowledgeExplorerPrisma;
}
