import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { connect } from './db';

/**
 * Guards the hand-written DDL at the end of the initial migration.
 *
 * The Prisma schema language cannot express partial indexes or CHECK
 * constraints, so they exist only as appended SQL. Regenerating the migration
 * would drop them silently and leave a schema that still migrates cleanly, so
 * these assertions are the only thing standing between that mistake and P8.
 */

let db: Client;

beforeAll(async () => {
  db = await connect();
});

afterAll(async () => {
  await db.end();
});

const partialUniqueIndexes = [
  'idx_chapters_order',
  'idx_lessons_order',
  'idx_products_single_course',
  'idx_products_category_bundle',
  'idx_access_grants_course',
  'idx_access_grants_category',
];

describe('partial unique indexes from §8', () => {
  it.each(partialUniqueIndexes)('%s exists, is unique, and is partial', async (name) => {
    const { rows } = await db.query<{ indisunique: boolean; has_predicate: boolean }>(
      `select i.indisunique, i.indpred is not null as has_predicate
         from pg_index i
         join pg_class c on c.oid = i.indexrelid
        where c.relname = $1`,
      [name],
    );
    expect(rows, `${name} is missing`).toHaveLength(1);
    expect(rows[0]!.indisunique, `${name} is not UNIQUE`).toBe(true);
    expect(rows[0]!.has_predicate, `${name} has no WHERE clause`).toBe(true);
  });

  it('scopes the ordering indexes to rows that are not soft-deleted', async () => {
    for (const name of ['idx_chapters_order', 'idx_lessons_order']) {
      const { rows } = await db.query<{ def: string }>(
        `select indexdef as def from pg_indexes where indexname = $1`,
        [name],
      );
      expect(rows[0]!.def).toContain('deleted_at IS NULL');
    }
  });

  it('scopes the product indexes to active rows of the matching type', async () => {
    const { rows } = await db.query<{ indexname: string; def: string }>(
      `select indexname, indexdef as def from pg_indexes
        where indexname in ('idx_products_single_course','idx_products_category_bundle')`,
    );
    const byName = new Map(rows.map((r) => [r.indexname, r.def]));
    expect(byName.get('idx_products_single_course')).toContain('is_active');
    expect(byName.get('idx_products_single_course')).toContain('single_course');
    expect(byName.get('idx_products_category_bundle')).toContain('is_active');
    expect(byName.get('idx_products_category_bundle')).toContain('category_bundle');
  });

  it('scopes the grant indexes to live (non-revoked) grants', async () => {
    const { rows } = await db.query<{ def: string }>(
      `select indexdef as def from pg_indexes
        where indexname in ('idx_access_grants_course','idx_access_grants_category')`,
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.def).toContain('revoked_at IS NULL');
  });
});

describe('partial non-unique index from §8', () => {
  it('idx_access_grants_expiry exists, is not unique, and is partial', async () => {
    const { rows } = await db.query<{ indisunique: boolean; has_predicate: boolean }>(
      `select i.indisunique, i.indpred is not null as has_predicate
         from pg_index i join pg_class c on c.oid = i.indexrelid
        where c.relname = 'idx_access_grants_expiry'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indisunique).toBe(false);
    expect(rows[0]!.has_predicate).toBe(true);
  });
});

describe('CHECK constraints from §8', () => {
  it.each([
    ['products', 'products_type_reference_check'],
    ['access_grants', 'access_grants_scope_reference_check'],
  ])('%s carries %s', async (table, constraint) => {
    const { rows } = await db.query(
      `select 1 from pg_constraint con
         join pg_class rel on rel.oid = con.conrelid
        where rel.relname = $1 and con.conname = $2 and con.contype = 'c'`,
      [table, constraint],
    );
    expect(rows, `${constraint} is missing from ${table}`).toHaveLength(1);
  });
});

/**
 * Catalog presence proves the objects exist. These prove they enforce the
 * invariant §8 wrote them for.
 */
describe('enforced behavior', () => {
  it('allows a soft-deleted chapter to share an order, but not two live ones', async () => {
    await db.query('BEGIN');
    try {
      const cat = await db.query<{ id: string }>(
        `insert into categories (slug, display_name) values ('t-cat','T') returning id`,
      );
      const course = await db.query<{ id: string }>(
        `insert into courses (category_id, slug, level_label, level_order, title)
         values ($1,'t-course','L1',1,'T') returning id`,
        [cat.rows[0]!.id],
      );
      const courseId = course.rows[0]!.id;

      await db.query(
        `insert into chapters (course_id, chapter_order, title) values ($1,1,'live')`,
        [courseId],
      );
      // A soft-deleted row at the same order is permitted by the WHERE clause.
      await db.query(
        `insert into chapters (course_id, chapter_order, title, deleted_at)
         values ($1,1,'deleted', now())`,
        [courseId],
      );
      // A second live row at the same order must be rejected.
      await expect(
        db.query(`insert into chapters (course_id, chapter_order, title) values ($1,1,'dup')`, [
          courseId,
        ]),
      ).rejects.toThrow(/idx_chapters_order/);
    } finally {
      await db.query('ROLLBACK');
    }
  });

  it('rejects a product whose type disagrees with the reference it carries', async () => {
    await db.query('BEGIN');
    try {
      const user = await db.query<{ id: string }>(
        `insert into users (email_address, user_role) values ('t-owner@example.test','admin_owner') returning id`,
      );
      const cat = await db.query<{ id: string }>(
        `insert into categories (slug, display_name) values ('t-cat2','T2') returning id`,
      );
      // single_course with a category_id and no course_id violates the CHECK.
      await expect(
        db.query(
          `insert into products (product_type, category_id, display_name, price_amount, created_by_user_id)
           values ('single_course', $1, 'bad', 1000, $2)`,
          [cat.rows[0]!.id, user.rows[0]!.id],
        ),
      ).rejects.toThrow(/products_type_reference_check/);
    } finally {
      await db.query('ROLLBACK');
    }
  });
});

/**
 * P9's migration, held to the same standard as §8's hand-written DDL.
 *
 * `20260913185000_add_topic_request_duplicate_of` is hand-written for the reason
 * its header records, so nothing regenerates it and nothing but these assertions
 * would notice if it were lost.
 */
describe('topic request duplicate pointer (P9)', () => {
  it('carries a self-referencing foreign key that NULLs on delete', async () => {
    const { rows } = await db.query<{ confdeltype: string; reftable: string }>(
      `select con.confdeltype, ref.relname as reftable
         from pg_constraint con
         join pg_class rel on rel.oid = con.conrelid
         join pg_class ref on ref.oid = con.confrelid
        where rel.relname = 'topic_requests'
          and con.conname = 'topic_requests_duplicate_of_request_id_fkey'
          and con.contype = 'f'`,
    );
    expect(rows, 'the duplicate_of foreign key is missing').toHaveLength(1);
    // 'n' is SET NULL. 'a' (NO ACTION) here would turn a learner withdrawing a
    // pending request that some duplicate names into a foreign-key error.
    expect(rows[0]!.confdeltype, 'ON DELETE is not SET NULL').toBe('n');
    expect(rows[0]!.reftable).toBe('topic_requests');
  });

  it.each(['idx_topic_requests_board', 'idx_topic_requests_requested_by'])(
    '%s exists and is a plain non-unique index',
    async (name) => {
      const { rows } = await db.query<{ indisunique: boolean; def: string }>(
        `select i.indisunique, pg_get_indexdef(i.indexrelid) as def
           from pg_index i
           join pg_class c on c.oid = i.indexrelid
          where c.relname = $1`,
        [name],
      );
      expect(rows, `${name} is missing`).toHaveLength(1);
      expect(rows[0]!.indisunique, `${name} should not be unique`).toBe(false);
    },
  );

  it('orders the board index by upvote_count descending', async () => {
    const { rows } = await db.query<{ def: string }>(
      `select indexdef as def from pg_indexes where indexname = 'idx_topic_requests_board'`,
    );
    expect(rows[0]!.def).toContain('request_status');
    // Without DESC the index cannot serve the board's ordering, and the query
    // still works — just sorted in memory, which is the silent version.
    expect(rows[0]!.def).toMatch(/upvote_count DESC/);
  });

  /**
   * Catalog presence proves the constraint exists. This proves it does the thing
   * it was chosen for, which is the only reason it departs from the project's
   * NoAction convention.
   */
  it('nulls the pointer when the duplicated-of request is deleted, rather than raising', async () => {
    await db.query('BEGIN');
    try {
      const user = await db.query<{ id: string }>(
        `insert into users (email_address, user_role) values ('t-req@example.test','learner') returning id`,
      );
      const userId = user.rows[0]!.id;

      const original = await db.query<{ id: string }>(
        `insert into topic_requests (requested_by_user_id, requested_topic_title)
         values ($1, 'original') returning id`,
        [userId],
      );
      const duplicate = await db.query<{ id: string }>(
        `insert into topic_requests
           (requested_by_user_id, requested_topic_title, request_status, duplicate_of_request_id)
         values ($1, 'duplicate', 'duplicated', $2) returning id`,
        [userId, original.rows[0]!.id],
      );

      await db.query(`delete from topic_requests where id = $1`, [original.rows[0]!.id]);

      const { rows } = await db.query<{
        duplicate_of_request_id: string | null;
        request_status: string;
      }>(`select duplicate_of_request_id, request_status from topic_requests where id = $1`, [
        duplicate.rows[0]!.id,
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.duplicate_of_request_id).toBeNull();
      // The status survives: it is still a duplicate, of a request that is gone.
      expect(rows[0]!.request_status).toBe('duplicated');
    } finally {
      await db.query('ROLLBACK');
    }
  });
});

/**
 * P8a's migration (specs/p8a-commerce/spec.md), held to the same standard.
 *
 * `20260914163500_add_discount_codes` appends four CHECK constraints and a
 * partial index that schema.prisma cannot express, so these assertions are the
 * only thing that would notice them missing.
 */
describe('discount codes and order pricing (P8a)', () => {
  it.each([
    'discount_codes_percent_off_check',
    'discount_codes_code_uppercase_check',
    'discount_codes_max_redemptions_check',
    'discount_codes_window_check',
  ])('discount_codes carries %s', async (constraint) => {
    const { rows } = await db.query(
      `select 1 from pg_constraint con
         join pg_class rel on rel.oid = con.conrelid
        where rel.relname = 'discount_codes' and con.conname = $1 and con.contype = 'c'`,
      [constraint],
    );
    expect(rows, `${constraint} is missing`).toHaveLength(1);
  });

  it.each([
    // 'a' is NO ACTION: an order keeps pointing at the code it was sold under.
    ['payment_orders', 'payment_orders_discount_code_id_fkey', 'discount_codes', 'a'],
    // 'c' is CASCADE: the join rows are meaningless without either side.
    ['discount_code_products', 'discount_code_products_discount_code_id_fkey', 'discount_codes', 'c'],
    ['discount_code_products', 'discount_code_products_product_id_fkey', 'products', 'c'],
  ])('%s carries %s to %s with ON DELETE %s', async (table, constraint, refTable, action) => {
    const { rows } = await db.query<{ confdeltype: string; reftable: string }>(
      `select con.confdeltype, ref.relname as reftable
         from pg_constraint con
         join pg_class rel on rel.oid = con.conrelid
         join pg_class ref on ref.oid = con.confrelid
        where rel.relname = $1 and con.conname = $2 and con.contype = 'f'`,
      [table, constraint],
    );
    expect(rows, `${constraint} is missing`).toHaveLength(1);
    expect(rows[0]!.reftable).toBe(refTable);
    expect(rows[0]!.confdeltype).toBe(action);
  });

  it('orders idx_payment_orders_user_created by created_at descending', async () => {
    const { rows } = await db.query<{ def: string }>(
      `select indexdef as def from pg_indexes where indexname = 'idx_payment_orders_user_created'`,
    );
    expect(rows, 'idx_payment_orders_user_created is missing').toHaveLength(1);
    expect(rows[0]!.def).toMatch(/user_id, created_at DESC/);
  });

  it('scopes idx_payment_orders_discount_paid to paid orders', async () => {
    const { rows } = await db.query<{ indisunique: boolean; def: string }>(
      `select i.indisunique, pg_get_indexdef(i.indexrelid) as def
         from pg_index i join pg_class c on c.oid = i.indexrelid
        where c.relname = 'idx_payment_orders_discount_paid'`,
    );
    expect(rows, 'idx_payment_orders_discount_paid is missing').toHaveLength(1);
    expect(rows[0]!.indisunique).toBe(false);
    // Without the predicate a redemption count would still be right, just
    // served by a larger index — the silent version.
    expect(rows[0]!.def).toMatch(/WHERE \(order_status = 'paid'::text\)/);
  });

  describe('enforced behavior', () => {
    let ownerId = '';

    beforeAll(async () => {
      await db.query('BEGIN');
      const user = await db.query<{ id: string }>(
        `insert into users (email_address, user_role)
         values ('t-codes@example.test','admin_owner') returning id`,
      );
      ownerId = user.rows[0]!.id;
    });

    afterAll(async () => {
      await db.query('ROLLBACK');
    });

    const insertCode = (code: string, percentOff: number) =>
      db.query(
        `insert into discount_codes (code, percent_off, created_by_user_id) values ($1, $2, $3)`,
        [code, percentOff, ownerId],
      );

    it.each([0, 101])('rejects percent_off = %i', async (percentOff) => {
      await db.query('SAVEPOINT s');
      await expect(insertCode(`PCT${percentOff}`, percentOff)).rejects.toThrow(
        /discount_codes_percent_off_check/,
      );
      await db.query('ROLLBACK TO SAVEPOINT s');
    });

    it('rejects a code that is not stored uppercase', async () => {
      await db.query('SAVEPOINT s');
      await expect(insertCode('welcome10', 10)).rejects.toThrow(
        /discount_codes_code_uppercase_check/,
      );
      await db.query('ROLLBACK TO SAVEPOINT s');
    });

    it('accepts 100 percent, which is a zero-amount order rather than a free grant', async () => {
      await db.query('SAVEPOINT s');
      await expect(insertCode('FREE100', 100)).resolves.toBeDefined();
      await db.query('ROLLBACK TO SAVEPOINT s');
    });
  });
});
