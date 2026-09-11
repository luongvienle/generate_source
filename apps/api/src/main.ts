import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

// Single .env at the repository root; this app runs two levels below it.
loadEnv({ path: ['../../.env', '.env'] });

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // §9 places every admin and public route under /api; health stays unprefixed
  // so liveness checks do not depend on the API's routing conventions.
  app.setGlobalPrefix('api', { exclude: ['health'] });
  const port = Number(process.env['API_PORT'] ?? 3001);
  await app.listen(port);
  new Logger('Bootstrap').log(`API listening on http://localhost:${port}`);
}

void bootstrap();
