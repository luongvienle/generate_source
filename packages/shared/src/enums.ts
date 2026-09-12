import { z } from 'zod';

/**
 * Enum-like values from knowledge-explorer-spec.md §8.1.
 *
 * §8 stores these as TEXT and validates them in the application layer, so these
 * schemas are the single source of truth. No other workspace may redeclare a
 * literal union for any column below.
 *
 * Values are the on-disk strings and stay snake_case exactly as §8.1 writes them.
 */

export const userRoles = ['admin_owner', 'admin', 'learner'] as const;
export const userRoleSchema = z.enum(userRoles);
export type UserRole = (typeof userRoles)[number];

export const publicationStatuses = [
  'draft',
  'in_review',
  'publishing',
  'published',
  'unpublished',
  'archived',
] as const;
export const publicationStatusSchema = z.enum(publicationStatuses);
export type PublicationStatus = (typeof publicationStatuses)[number];

export const contentStatuses = ['empty', 'drafting', 'ready', 'published'] as const;
export const contentStatusSchema = z.enum(contentStatuses);
export type ContentStatus = (typeof contentStatuses)[number];

/** §8.1 gives script_status and audio_status one shared row of allowed values. */
export const generationStatuses = ['pending', 'generating', 'ready', 'stale', 'failed'] as const;
export const scriptStatusSchema = z.enum(generationStatuses);
export const audioStatusSchema = z.enum(generationStatuses);
export type ScriptStatus = (typeof generationStatuses)[number];
export type AudioStatus = (typeof generationStatuses)[number];

export const imageSources = ['ai_generated', 'uploaded'] as const;
export const imageSourceSchema = z.enum(imageSources);
export type ImageSource = (typeof imageSources)[number];

export const pricingTypes = ['free', 'paid'] as const;
export const pricingTypeSchema = z.enum(pricingTypes);
export type PricingType = (typeof pricingTypes)[number];

export const productTypes = ['single_course', 'category_bundle'] as const;
export const productTypeSchema = z.enum(productTypes);
export type ProductType = (typeof productTypes)[number];

/** `snapshot_at_purchase` is reserved: §7.2 locks v1 to all_current_and_future. */
export const bundleInclusionPolicies = ['all_current_and_future', 'snapshot_at_purchase'] as const;
export const bundleInclusionPolicySchema = z.enum(bundleInclusionPolicies);
export type BundleInclusionPolicy = (typeof bundleInclusionPolicies)[number];

/** `auto` is reserved: §7.4 locks v1 to manual renewal. */
export const renewalTypes = ['manual', 'auto'] as const;
export const renewalTypeSchema = z.enum(renewalTypes);
export type RenewalType = (typeof renewalTypes)[number];

export const scopeTypes = ['course', 'category'] as const;
export const scopeTypeSchema = z.enum(scopeTypes);
export type ScopeType = (typeof scopeTypes)[number];

export const accessSources = ['purchase', 'granted_by_owner'] as const;
export const accessSourceSchema = z.enum(accessSources);
export type AccessSource = (typeof accessSources)[number];

export const orderStatuses = ['pending', 'paid', 'failed', 'refunded'] as const;
export const orderStatusSchema = z.enum(orderStatuses);
export type OrderStatus = (typeof orderStatuses)[number];

export const progressStatuses = ['not_started', 'in_progress', 'completed'] as const;
export const progressStatusSchema = z.enum(progressStatuses);
export type ProgressStatus = (typeof progressStatuses)[number];

export const requestStatuses = ['pending', 'accepted', 'rejected', 'duplicated'] as const;
export const requestStatusSchema = z.enum(requestStatuses);
export type RequestStatus = (typeof requestStatuses)[number];

export const jobTypes = [
  'generate_image',
  'generate_narration_script',
  'generate_audio',
  'publish_course',
  'import_course_outline',
  'send_expiry_reminder',
] as const;
export const jobTypeSchema = z.enum(jobTypes);
export type JobType = (typeof jobTypes)[number];

/**
 * Job execution status.
 *
 * NOT catalogued by §8.1, which lists no members for `generation_jobs.job_status`
 * even though §8 defaults the column to 'queued'. These members are decided by
 * specs/p1-curriculum/spec.md: job-lifecycle vocabulary, deliberately distinct
 * from `generationStatuses` above because a job is never 'stale'.
 */
export const jobStatuses = ['queued', 'running', 'succeeded', 'failed'] as const;
export const jobStatusSchema = z.enum(jobStatuses);
export type JobStatus = (typeof jobStatuses)[number];

/**
 * Every enum-like column, keyed by its database column name, so tests and
 * tooling can assert coverage without restating the members.
 *
 * All but the last are catalogued by §8.1; `job_status` is not — see its
 * declaration above.
 */
export const enumColumns = {
  user_role: userRoles,
  publication_status: publicationStatuses,
  content_status: contentStatuses,
  script_status: generationStatuses,
  audio_status: generationStatuses,
  image_source: imageSources,
  pricing_type: pricingTypes,
  product_type: productTypes,
  bundle_inclusion_policy: bundleInclusionPolicies,
  renewal_type: renewalTypes,
  scope_type: scopeTypes,
  access_source: accessSources,
  order_status: orderStatuses,
  progress_status: progressStatuses,
  request_status: requestStatuses,
  job_type: jobTypes,
  job_status: jobStatuses,
} as const;
