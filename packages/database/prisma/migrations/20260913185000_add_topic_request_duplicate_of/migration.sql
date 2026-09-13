/*
  Hand-written, not generated. `prisma migrate dev` must never run in this
  repository: 20260911180121_init carries six partial unique indexes, one partial
  index and two CHECK constraints appended below its generated section, they
  replay into the shadow database but do not appear in schema.prisma, and a
  diff-based generator therefore has every reason to emit DROP INDEX for them.
  `prisma migrate diff` reports "No difference detected" either way, so the
  mistake has no symptom. See CLAUDE.md invariant 1; packages/database/test/
  constraints.spec.ts is the guard.

  P9 (specs/p9-topic-requests/). §8's topic_requests row carries request_status
  = 'duplicated' with nowhere to record WHAT it duplicates.

  ON DELETE SET NULL is deliberate and departs from the project-wide "NoAction
  where §8 omits it" convention: a learner may withdraw a pending request that is
  some duplicate's target, and NoAction turns that into a foreign-key error the
  learner cannot act on.
*/

-- AlterTable
ALTER TABLE "topic_requests" ADD COLUMN     "duplicate_of_request_id" UUID;

-- AddForeignKey
ALTER TABLE "topic_requests" ADD CONSTRAINT "topic_requests_duplicate_of_request_id_fkey" FOREIGN KEY ("duplicate_of_request_id") REFERENCES "topic_requests"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- CreateIndex
CREATE INDEX "idx_topic_requests_board" ON "topic_requests"("request_status", "upvote_count" DESC);

-- CreateIndex
CREATE INDEX "idx_topic_requests_requested_by" ON "topic_requests"("requested_by_user_id");
