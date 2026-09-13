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

  /**
   * Both web apps run on their own port, so every browser call is cross-origin.
   *
   * Credentialed CORS must echo ONE specific origin — the browser refuses '*'
   * once cookies are attached, and the session cookie is how the API resolves
   * identity (FR-AUTH-02). So this is an allowlist that echoes the matching
   * entry per request, never a wildcard and never a reflection of whatever
   * Origin arrived.
   *
   * P7 added the second entry: learner-web is a separate deployable (§11) on
   * :3002 locally, and until it was allowed here every learner request failed in
   * the browser with a CORS error and a perfectly healthy 200 in the API log.
   */
  const allowedOrigins = (
    process.env['CORS_ORIGINS'] ??
    [process.env['AUTH_URL'] ?? 'http://localhost:3000', process.env['LEARNER_AUTH_URL'] ?? 'http://localhost:3002'].join(',')
  )
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  app.enableCors({
    origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
      // A request with no Origin header is not a browser cross-origin call —
      // curl, a server-side fetch, a health probe — and is left alone.
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      callback(null, false);
    },
    credentials: true,
  });
  const port = Number(process.env['API_PORT'] ?? 3001);
  await app.listen(port);
  new Logger('Bootstrap').log(`API listening on http://localhost:${port}`);
}

void bootstrap();
