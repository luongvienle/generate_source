import { config as loadEnv } from 'dotenv';
import { defineConfig, env } from 'prisma/config';

// The repository root holds the single .env; this package is two levels down.
loadEnv({ path: '../../.env' });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
