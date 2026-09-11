import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';

loadEnv({ path: '../../.env' });

export async function connect(): Promise<Client> {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is not set; copy .env.example to .env');
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}
