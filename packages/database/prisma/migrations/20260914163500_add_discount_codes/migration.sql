/*
  Hand-written, not generated. `prisma migrate dev` must never run in this
  repository: 20260911180121_init carries six partial unique indexes, one partial
  index and two CHECK constraints appended below its generated section, they
  replay into the shadow database but do not appear in schema.prisma, and a
  diff-based generator therefore has every reason to emit DROP INDEX for them.
  `prisma migrate diff` reports "No difference detected" either way, so the
  mistake has no symptom. See CLAUDE.md invariant 1; packages/database/test/
  constraints.spec.ts is the guard.

  P8a (specs/p8a-commerce/spec.md). Discount codes are not in §5.9 or §8; they
  were added to P8a by decision, so this migration adds two tables and two
  columns on `payment_orders`.

  `list_price_amount` is NOT NULL with no default and no backfill, deliberately.
  Nothing wrote `payment_orders` before P8a, so there is no row to backfill; a
  development database holding hand-seeded orders fails here loudly rather than
  having a price invented for it.
*/

-- CreateTable
CREATE TABLE "discount_codes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "percent_off" INTEGER NOT NULL,
    "applies_to_all_products" BOOLEAN NOT NULL DEFAULT false,
    "starts_at" TIMESTAMPTZ(6),
    "ends_at" TIMESTAMPTZ(6),
    "max_redemptions" INTEGER,
    "once_per_learner" BOOLEAN NOT NULL DEFAULT false,
    "new_purchases_only" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discount_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discount_code_products" (
    "discount_code_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,

    CONSTRAINT "discount_code_products_pkey" PRIMARY KEY ("discount_code_id","product_id")
);

-- AlterTable
ALTER TABLE "payment_orders" ADD COLUMN     "list_price_amount" DECIMAL(12,2) NOT NULL,
ADD COLUMN     "discount_code_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "discount_codes_code_key" ON "discount_codes"("code");

-- CreateIndex
-- The hourly checkout cap and GET /me/orders both read a learner's newest orders.
CREATE INDEX "idx_payment_orders_user_created" ON "payment_orders"("user_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "discount_codes" ADD CONSTRAINT "discount_codes_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "discount_code_products" ADD CONSTRAINT "discount_code_products_discount_code_id_fkey" FOREIGN KEY ("discount_code_id") REFERENCES "discount_codes"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "discount_code_products" ADD CONSTRAINT "discount_code_products_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_discount_code_id_fkey" FOREIGN KEY ("discount_code_id") REFERENCES "discount_codes"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- Hand-written DDL that the Prisma schema language cannot express. Asserted by
-- the "discount codes and order pricing (P8a)" block in constraints.spec.ts.
-- ---------------------------------------------------------------------------

-- A percentage off. 100 is allowed: a zero-amount order still goes through the
-- provider and the webhook (FR-COM-03 has no exception for free).
ALTER TABLE "discount_codes" ADD CONSTRAINT "discount_codes_percent_off_check"
    CHECK ("percent_off" BETWEEN 1 AND 100);

-- Codes match case-insensitively by being stored uppercase; the API normalizes,
-- and this makes a lowercase row impossible rather than merely unlikely.
ALTER TABLE "discount_codes" ADD CONSTRAINT "discount_codes_code_uppercase_check"
    CHECK ("code" = upper("code"));

ALTER TABLE "discount_codes" ADD CONSTRAINT "discount_codes_max_redemptions_check"
    CHECK ("max_redemptions" IS NULL OR "max_redemptions" >= 1);

ALTER TABLE "discount_codes" ADD CONSTRAINT "discount_codes_window_check"
    CHECK ("starts_at" IS NULL OR "ends_at" IS NULL OR "starts_at" < "ends_at");

-- A redemption is a PAID order carrying the code; pending and failed orders do
-- not count, so the index covers exactly the rows a redemption count reads.
CREATE INDEX "idx_payment_orders_discount_paid" ON "payment_orders"("discount_code_id")
    WHERE "order_status" = 'paid';
