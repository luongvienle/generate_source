import type { Prisma } from '@prisma/client';

/**
 * Making room before an order rewrite.
 *
 * §8 enforces ordering with `idx_chapters_order` and `idx_lessons_order`, both
 * declared `CREATE UNIQUE INDEX ... WHERE deleted_at IS NULL`. PostgreSQL can
 * defer a unique *constraint* declared DEFERRABLE; it cannot defer a unique
 * *index*, which is checked per row as it is written. Making them deferrable
 * would mean editing the initial migration, which conventions.md records as
 * critical invariant #1 — never regenerate it, the hand-written SQL below its
 * generated section would be lost.
 *
 * So any rewrite parks the affected rows in a disjoint negative range first.
 * `-order - 1` keeps them unique among themselves (order is unique and positive
 * among non-deleted rows) and cannot collide with the positive range the rewrite
 * then writes into. A full reversal is the case that proves it.
 */

export type OrderingTx = Pick<Prisma.TransactionClient, '$executeRaw'>;

export async function parkChapterOrders(tx: OrderingTx, courseId: string): Promise<void> {
  await tx.$executeRaw`
    UPDATE chapters
       SET chapter_order = -chapter_order - 1
     WHERE course_id = ${courseId}::uuid
       AND deleted_at IS NULL
       AND chapter_order >= 0
  `;
}

export async function parkLessonOrders(tx: OrderingTx, chapterIds: string[]): Promise<void> {
  if (chapterIds.length === 0) return;
  await tx.$executeRaw`
    UPDATE lessons
       SET lesson_order = -lesson_order - 1
     WHERE chapter_id = ANY(${chapterIds}::uuid[])
       AND deleted_at IS NULL
       AND lesson_order >= 0
  `;
}
