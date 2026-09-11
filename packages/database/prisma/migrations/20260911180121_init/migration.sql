-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email_address" TEXT NOT NULL,
    "display_name" TEXT,
    "user_role" TEXT NOT NULL DEFAULT 'learner',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "email_verified" TIMESTAMPTZ(6),
    "image_url" TEXT,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "description" TEXT,
    "cover_image_url" TEXT,
    "display_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "courses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "category_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "level_label" TEXT NOT NULL,
    "level_order" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "overview_summary" TEXT,
    "prerequisites" JSONB NOT NULL DEFAULT '[]',
    "learning_objectives" JSONB NOT NULL DEFAULT '[]',
    "estimated_total_minutes" INTEGER,
    "cover_image_url" TEXT,
    "language_code" TEXT NOT NULL DEFAULT 'vi',
    "pricing_type" TEXT NOT NULL DEFAULT 'free',
    "publication_status" TEXT NOT NULL DEFAULT 'draft',
    "has_unpublished_changes" BOOLEAN NOT NULL DEFAULT false,
    "published_at" TIMESTAMPTZ(6),
    "imported_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chapters" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "course_id" UUID NOT NULL,
    "chapter_order" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "assigned_admin_id" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "chapters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lessons" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "chapter_id" UUID NOT NULL,
    "lesson_order" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "learning_objective" TEXT,
    "key_points" JSONB NOT NULL DEFAULT '[]',
    "estimated_minutes" INTEGER,
    "is_free_preview" BOOLEAN NOT NULL DEFAULT false,
    "content_status" TEXT NOT NULL DEFAULT 'empty',
    "assigned_admin_id" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "lessons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lesson_contents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "lesson_id" UUID NOT NULL,
    "draft_content_markdown" TEXT,
    "draft_block_list" JSONB,
    "draft_content_checksum" TEXT,
    "published_content_markdown" TEXT,
    "published_block_list" JSONB,
    "last_edited_by_user_id" UUID,
    "draft_updated_at" TIMESTAMPTZ(6),
    "published_at" TIMESTAMPTZ(6),

    CONSTRAINT "lesson_contents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lesson_images" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "lesson_id" UUID NOT NULL,
    "block_reference_id" TEXT NOT NULL,
    "figure_number" INTEGER,
    "image_file_url" TEXT NOT NULL,
    "caption_text" TEXT NOT NULL,
    "alternative_text" TEXT NOT NULL,
    "image_source" TEXT NOT NULL DEFAULT 'ai_generated',
    "image_prompt_text" TEXT,
    "image_model_name" TEXT,
    "image_provider_name" TEXT,
    "is_selected" BOOLEAN NOT NULL DEFAULT false,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lesson_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "narration_scripts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "lesson_id" UUID NOT NULL,
    "script_segments" JSONB NOT NULL,
    "script_checksum" TEXT NOT NULL,
    "source_content_checksum" TEXT NOT NULL,
    "script_status" TEXT NOT NULL DEFAULT 'pending',
    "generator_model_name" TEXT,
    "generator_prompt_version" TEXT,
    "input_token_count" INTEGER,
    "output_token_count" INTEGER,
    "reviewed_by_user_id" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "narration_scripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lesson_audios" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "lesson_id" UUID NOT NULL,
    "voice_provider_name" TEXT NOT NULL,
    "voice_identifier" TEXT NOT NULL,
    "merged_audio_file_url" TEXT NOT NULL,
    "total_duration_seconds" INTEGER,
    "total_character_count" INTEGER,
    "source_script_checksum" TEXT NOT NULL,
    "audio_status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lesson_audios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audio_segments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "lesson_audio_id" UUID NOT NULL,
    "block_reference_id" TEXT NOT NULL,
    "segment_order" INTEGER NOT NULL,
    "start_millisecond" INTEGER NOT NULL,
    "end_millisecond" INTEGER NOT NULL,
    "segment_audio_file_url" TEXT,

    CONSTRAINT "audio_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "published_course_structures" (
    "course_id" UUID NOT NULL,
    "structure_payload" JSONB NOT NULL,
    "total_lesson_count" INTEGER NOT NULL,
    "published_version_number" INTEGER NOT NULL DEFAULT 1,
    "published_by_user_id" UUID NOT NULL,
    "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "published_course_structures_pkey" PRIMARY KEY ("course_id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_type" TEXT NOT NULL,
    "course_id" UUID,
    "category_id" UUID,
    "display_name" TEXT NOT NULL,
    "price_amount" DECIMAL(12,2) NOT NULL,
    "currency_code" TEXT NOT NULL DEFAULT 'VND',
    "access_duration_days" INTEGER NOT NULL DEFAULT 365,
    "grace_period_days" INTEGER NOT NULL DEFAULT 0,
    "renewal_type" TEXT NOT NULL DEFAULT 'manual',
    "bundle_inclusion_policy" TEXT NOT NULL DEFAULT 'all_current_and_future',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_grants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "scope_type" TEXT NOT NULL,
    "scope_course_id" UUID,
    "scope_category_id" UUID,
    "access_source" TEXT NOT NULL,
    "source_product_id" UUID,
    "payment_order_id" UUID,
    "granted_by_user_id" UUID,
    "expires_at" TIMESTAMPTZ(6),
    "grace_period_days" INTEGER NOT NULL DEFAULT 0,
    "renewal_count" INTEGER NOT NULL DEFAULT 0,
    "sent_reminder_milestones" JSONB NOT NULL DEFAULT '[]',
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "provider_name" TEXT NOT NULL,
    "provider_order_reference" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency_code" TEXT NOT NULL,
    "order_status" TEXT NOT NULL DEFAULT 'pending',
    "raw_webhook_payload" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "payment_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lesson_progress" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "lesson_id" UUID NOT NULL,
    "progress_status" TEXT NOT NULL DEFAULT 'not_started',
    "last_scroll_percentage" SMALLINT NOT NULL DEFAULT 0,
    "last_audio_position_ms" INTEGER NOT NULL DEFAULT 0,
    "completed_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lesson_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "topic_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "requested_by_user_id" UUID NOT NULL,
    "requested_topic_title" TEXT NOT NULL,
    "request_description" TEXT,
    "request_status" TEXT NOT NULL DEFAULT 'pending',
    "upvote_count" INTEGER NOT NULL DEFAULT 0,
    "reviewer_note" TEXT,
    "reviewed_by_user_id" UUID,
    "linked_course_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "topic_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "topic_request_votes" (
    "topic_request_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "topic_request_votes_pkey" PRIMARY KEY ("topic_request_id","user_id")
);

-- CreateTable
CREATE TABLE "generation_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "job_type" TEXT NOT NULL,
    "target_entity_id" UUID NOT NULL,
    "job_status" TEXT NOT NULL DEFAULT 'queued',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "generation_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_account_id" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_token" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "expires" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_tokens" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMPTZ(6) NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_address_key" ON "users"("email_address");

-- CreateIndex
CREATE UNIQUE INDEX "categories_slug_key" ON "categories"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "courses_slug_key" ON "courses"("slug");

-- CreateIndex
CREATE INDEX "idx_courses_catalog" ON "courses"("publication_status", "category_id", "level_order");

-- CreateIndex
CREATE UNIQUE INDEX "courses_category_id_level_order_key" ON "courses"("category_id", "level_order");

-- CreateIndex
CREATE UNIQUE INDEX "lesson_contents_lesson_id_key" ON "lesson_contents"("lesson_id");

-- CreateIndex
CREATE INDEX "idx_lesson_images_lesson" ON "lesson_images"("lesson_id", "block_reference_id");

-- CreateIndex
CREATE UNIQUE INDEX "narration_scripts_lesson_id_key" ON "narration_scripts"("lesson_id");

-- CreateIndex
CREATE UNIQUE INDEX "lesson_audios_lesson_id_voice_identifier_key" ON "lesson_audios"("lesson_id", "voice_identifier");

-- CreateIndex
CREATE UNIQUE INDEX "audio_segments_lesson_audio_id_segment_order_key" ON "audio_segments"("lesson_audio_id", "segment_order");

-- CreateIndex
CREATE UNIQUE INDEX "payment_orders_provider_name_provider_order_reference_key" ON "payment_orders"("provider_name", "provider_order_reference");

-- CreateIndex
CREATE UNIQUE INDEX "lesson_progress_user_id_lesson_id_key" ON "lesson_progress"("user_id", "lesson_id");

-- CreateIndex
CREATE INDEX "idx_generation_jobs_target" ON "generation_jobs"("target_entity_id", "job_type");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_provider_provider_account_id_key" ON "accounts"("provider", "provider_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_session_token_key" ON "sessions"("session_token");

-- CreateIndex
CREATE INDEX "idx_sessions_user" ON "sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "verification_tokens_token_key" ON "verification_tokens"("token");

-- CreateIndex
CREATE UNIQUE INDEX "verification_tokens_identifier_token_key" ON "verification_tokens"("identifier", "token");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "courses" ADD CONSTRAINT "courses_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "courses" ADD CONSTRAINT "courses_imported_by_user_id_fkey" FOREIGN KEY ("imported_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_assigned_admin_id_fkey" FOREIGN KEY ("assigned_admin_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_chapter_id_fkey" FOREIGN KEY ("chapter_id") REFERENCES "chapters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_assigned_admin_id_fkey" FOREIGN KEY ("assigned_admin_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lesson_contents" ADD CONSTRAINT "lesson_contents_lesson_id_fkey" FOREIGN KEY ("lesson_id") REFERENCES "lessons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lesson_contents" ADD CONSTRAINT "lesson_contents_last_edited_by_user_id_fkey" FOREIGN KEY ("last_edited_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lesson_images" ADD CONSTRAINT "lesson_images_lesson_id_fkey" FOREIGN KEY ("lesson_id") REFERENCES "lessons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lesson_images" ADD CONSTRAINT "lesson_images_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "narration_scripts" ADD CONSTRAINT "narration_scripts_lesson_id_fkey" FOREIGN KEY ("lesson_id") REFERENCES "lessons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narration_scripts" ADD CONSTRAINT "narration_scripts_reviewed_by_user_id_fkey" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lesson_audios" ADD CONSTRAINT "lesson_audios_lesson_id_fkey" FOREIGN KEY ("lesson_id") REFERENCES "lessons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_segments" ADD CONSTRAINT "audio_segments_lesson_audio_id_fkey" FOREIGN KEY ("lesson_audio_id") REFERENCES "lesson_audios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "published_course_structures" ADD CONSTRAINT "published_course_structures_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "published_course_structures" ADD CONSTRAINT "published_course_structures_published_by_user_id_fkey" FOREIGN KEY ("published_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_scope_course_id_fkey" FOREIGN KEY ("scope_course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_scope_category_id_fkey" FOREIGN KEY ("scope_category_id") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_source_product_id_fkey" FOREIGN KEY ("source_product_id") REFERENCES "products"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_granted_by_user_id_fkey" FOREIGN KEY ("granted_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lesson_progress" ADD CONSTRAINT "lesson_progress_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lesson_progress" ADD CONSTRAINT "lesson_progress_lesson_id_fkey" FOREIGN KEY ("lesson_id") REFERENCES "lessons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topic_requests" ADD CONSTRAINT "topic_requests_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topic_requests" ADD CONSTRAINT "topic_requests_reviewed_by_user_id_fkey" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "topic_requests" ADD CONSTRAINT "topic_requests_linked_course_id_fkey" FOREIGN KEY ("linked_course_id") REFERENCES "courses"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "topic_request_votes" ADD CONSTRAINT "topic_request_votes_topic_request_id_fkey" FOREIGN KEY ("topic_request_id") REFERENCES "topic_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topic_request_votes" ADD CONSTRAINT "topic_request_votes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written DDL: constructs spec §8 requires that the Prisma schema
-- language cannot express.
--
-- DO NOT REGENERATE THIS MIGRATION. `prisma migrate dev` would rewrite the
-- generated section above and silently discard everything below, leaving a
-- schema that migrates cleanly and then admits duplicate chapter ordering and
-- two active products for the same course.
--
-- packages/database/test/constraints.spec.ts asserts every object below
-- against the Postgres catalogs, so a regression fails the test suite.
-- ---------------------------------------------------------------------------

-- Ordering is unique only among rows that are not soft-deleted (§8, §4.3).
CREATE UNIQUE INDEX "idx_chapters_order"
    ON "chapters"("course_id", "chapter_order") WHERE "deleted_at" IS NULL;

CREATE UNIQUE INDEX "idx_lessons_order"
    ON "lessons"("chapter_id", "lesson_order") WHERE "deleted_at" IS NULL;

-- §7.1: at most one active product per course and one per category.
CREATE UNIQUE INDEX "idx_products_single_course"
    ON "products"("course_id")   WHERE "product_type" = 'single_course'   AND "is_active";

CREATE UNIQUE INDEX "idx_products_category_bundle"
    ON "products"("category_id") WHERE "product_type" = 'category_bundle' AND "is_active";

-- §7.2: one live grant per learner per scope; revoked rows do not collide.
CREATE UNIQUE INDEX "idx_access_grants_course"
    ON "access_grants"("user_id", "scope_course_id")
    WHERE "scope_type" = 'course'   AND "revoked_at" IS NULL;

CREATE UNIQUE INDEX "idx_access_grants_category"
    ON "access_grants"("user_id", "scope_category_id")
    WHERE "scope_type" = 'category' AND "revoked_at" IS NULL;

-- §7.5: the daily reminder job scans live grants by expiry.
CREATE INDEX "idx_access_grants_expiry"
    ON "access_grants"("expires_at")
    WHERE "revoked_at" IS NULL AND "expires_at" IS NOT NULL;

-- §7.1: a product references exactly one of course or category, matching its type.
ALTER TABLE "products" ADD CONSTRAINT "products_type_reference_check" CHECK (
    ("product_type" = 'single_course'   AND "course_id"   IS NOT NULL AND "category_id" IS NULL) OR
    ("product_type" = 'category_bundle' AND "category_id" IS NOT NULL AND "course_id"   IS NULL)
);

-- §7.2: a grant is scoped to exactly one of course or category, matching its type.
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_scope_reference_check" CHECK (
    ("scope_type" = 'course'   AND "scope_course_id"   IS NOT NULL AND "scope_category_id" IS NULL) OR
    ("scope_type" = 'category' AND "scope_category_id" IS NOT NULL AND "scope_course_id"   IS NULL)
);
