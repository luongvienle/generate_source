import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadEnv } from 'dotenv';
import { AppModule } from '../src/app.module';

loadEnv({ path: ['../../.env', '.env'] });

/**
 * Boots the real module graph against the migrated database, so a broken
 * provider wiring or an unreachable database fails here rather than in
 * production. P0's non-goals keep this to database connectivity only.
 */
describe('GET /health', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 and confirms a database round trip', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);
    expect(response.body).toEqual({ status: 'ok', database: 'ok' });
  });
});
