import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { connect } from './db';

/**
 * Proves the approved additive deviation stayed additive.
 *
 * P0 adds three Auth.js adapter tables and two nullable columns to `users`.
 * Nothing in §8 may be renamed, retyped or dropped to accommodate them, so the
 * expectations below are transcribed straight from §8.
 */

let db: Client;

beforeAll(async () => {
  db = await connect();
});

afterAll(async () => {
  await db.end();
});

const tablesInSpec8 = [
  'users',
  'categories',
  'courses',
  'chapters',
  'lessons',
  'lesson_contents',
  'lesson_images',
  'narration_scripts',
  'lesson_audios',
  'audio_segments',
  'published_course_structures',
  'products',
  'access_grants',
  'payment_orders',
  'lesson_progress',
  'topic_requests',
  'topic_request_votes',
  'generation_jobs',
];

const adapterTables = ['accounts', 'sessions', 'verification_tokens'];

/**
 * Tables a later phase added under an approved spec, each through its own
 * hand-written migration rather than an edit to §8's.
 *
 * Declared by name rather than by loosening the check below: its purpose is
 * that no table appears SILENTLY, and a named addition still satisfies that.
 * An undeclared table keeps failing.
 *
 * P8a (specs/p8a-commerce/spec.md): discount codes are not in §5.9 or §8.
 */
const tablesAddedAfterSpec8 = ['discount_codes', 'discount_code_products'];

/** §8's users table, column name -> information_schema data_type. */
const usersColumnsInSpec8: Record<string, string> = {
  id: 'uuid',
  email_address: 'text',
  display_name: 'text',
  user_role: 'text',
  is_active: 'boolean',
  created_by_user_id: 'uuid',
  created_at: 'timestamp with time zone',
};

/** Additive columns the Auth.js adapter requires. Not in §8. */
const usersColumnsAddedForAuth: Record<string, string> = {
  email_verified: 'timestamp with time zone',
  image_url: 'text',
};

describe('§8 tables', () => {
  it('all 18 exist', async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    const present = new Set(rows.map((r) => r.table_name));
    for (const t of tablesInSpec8) expect(present.has(t), `${t} is missing`).toBe(true);
    expect(tablesInSpec8).toHaveLength(18);
  });

  it('the three adapter tables exist alongside them', async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_name = any($1)`,
      [adapterTables],
    );
    expect(rows.map((r) => r.table_name).sort()).toEqual([...adapterTables].sort());
  });

  it('adds no table beyond §8, the adapter, declared additions, and Prisma bookkeeping', async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    const allowed = new Set([
      ...tablesInSpec8,
      ...adapterTables,
      ...tablesAddedAfterSpec8,
      '_prisma_migrations',
    ]);
    const unexpected = rows.map((r) => r.table_name).filter((t) => !allowed.has(t));
    expect(unexpected).toEqual([]);
  });
});

describe('users retains its §8 shape', () => {
  it.each(Object.entries(usersColumnsInSpec8))(
    '%s is still present as %s',
    async (column, dataType) => {
      const { rows } = await db.query<{ data_type: string }>(
        `select data_type from information_schema.columns
          where table_schema = 'public' and table_name = 'users' and column_name = $1`,
        [column],
      );
      expect(rows, `users.${column} is missing`).toHaveLength(1);
      expect(rows[0]!.data_type).toBe(dataType);
    },
  );

  it('keeps email_address unique, as §8 declares', async () => {
    const { rows } = await db.query(
      `select 1 from pg_index i
         join pg_class c on c.oid = i.indexrelid
         join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
        where i.indisunique and a.attname = 'email_address'
          and i.indrelid = 'users'::regclass`,
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('adds exactly the two auth columns and nothing else', async () => {
    const { rows } = await db.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `select column_name, data_type, is_nullable from information_schema.columns
        where table_schema = 'public' and table_name = 'users'`,
    );
    const expected = new Set([
      ...Object.keys(usersColumnsInSpec8),
      ...Object.keys(usersColumnsAddedForAuth),
    ]);
    expect(rows.map((r) => r.column_name).sort()).toEqual([...expected].sort());

    // The additions must be nullable, so §8's inserts remain valid unchanged.
    for (const [column, dataType] of Object.entries(usersColumnsAddedForAuth)) {
      const row = rows.find((r) => r.column_name === column);
      expect(row, `users.${column} is missing`).toBeDefined();
      expect(row!.data_type).toBe(dataType);
      expect(row!.is_nullable, `users.${column} must be nullable`).toBe('YES');
    }
  });
});

describe('§8 type choices survive', () => {
  it('stores money as numeric(12,2), never a float', async () => {
    const { rows } = await db.query<{
      table_name: string;
      numeric_precision: number;
      numeric_scale: number;
      data_type: string;
    }>(
      `select table_name, data_type, numeric_precision, numeric_scale
         from information_schema.columns
        where table_schema = 'public'
          and (table_name, column_name) in (('products','price_amount'), ('payment_orders','amount'),
                                            -- P8a: the pre-discount price an order was sold at.
                                            ('payment_orders','list_price_amount'))`,
    );
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.data_type).toBe('numeric');
      expect(r.numeric_precision).toBe(12);
      expect(r.numeric_scale).toBe(2);
    }
  });

  it('uses timestamptz for every timestamp column', async () => {
    const { rows } = await db.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'public' and table_name <> '_prisma_migrations'
          and data_type in ('timestamp without time zone')`,
    );
    expect(rows).toEqual([]);
  });

  it('keeps enum-like columns as text, not native enums', async () => {
    const { rows } = await db.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns
        where table_schema = 'public'
          and column_name in ('user_role','publication_status','content_status','script_status',
                              'audio_status','image_source','pricing_type','product_type',
                              'bundle_inclusion_policy','renewal_type','scope_type',
                              'access_source','order_status','progress_status','request_status','job_type')`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.data_type, r.column_name).toBe('text');
  });
});
