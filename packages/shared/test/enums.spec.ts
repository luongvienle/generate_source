import { describe, expect, it } from 'vitest';
import { enumColumns } from '../src/enums';
import * as shared from '../src/index';

/**
 * The expected values below are transcribed independently from
 * knowledge-explorer-spec.md §8.1. They are deliberately literal rather than
 * imported: comparing the module against itself would assert nothing. If §8.1
 * changes, both this table and src/enums.ts must be updated, and the diff shows it.
 */
const specifiedIn_8_1: Record<string, readonly string[]> = {
  user_role: ['admin_owner', 'admin', 'learner'],
  publication_status: ['draft', 'in_review', 'publishing', 'published', 'unpublished', 'archived'],
  content_status: ['empty', 'drafting', 'ready', 'published'],
  script_status: ['pending', 'generating', 'ready', 'stale', 'failed'],
  audio_status: ['pending', 'generating', 'ready', 'stale', 'failed'],
  image_source: ['ai_generated', 'uploaded'],
  pricing_type: ['free', 'paid'],
  product_type: ['single_course', 'category_bundle'],
  bundle_inclusion_policy: ['all_current_and_future', 'snapshot_at_purchase'],
  renewal_type: ['manual', 'auto'],
  scope_type: ['course', 'category'],
  access_source: ['purchase', 'granted_by_owner'],
  order_status: ['pending', 'paid', 'failed', 'refunded'],
  progress_status: ['not_started', 'in_progress', 'completed'],
  request_status: ['pending', 'accepted', 'rejected', 'duplicated'],
  job_type: [
    'generate_image',
    'generate_narration_script',
    'generate_audio',
    'publish_course',
    'import_course_outline',
    'send_expiry_reminder',
  ],
};

describe('§8.1 enum-like columns', () => {
  it('covers every column §8.1 catalogues, and no extras', () => {
    expect(Object.keys(enumColumns).sort()).toEqual(Object.keys(specifiedIn_8_1).sort());
  });

  it('catalogues 16 columns across the 15 rows of §8.1', () => {
    // script_status and audio_status share one row in the spec table.
    expect(Object.keys(enumColumns)).toHaveLength(16);
    expect(enumColumns.script_status).toEqual(enumColumns.audio_status);
  });

  for (const [column, expected] of Object.entries(specifiedIn_8_1)) {
    it(`${column} allows exactly the values §8.1 lists, in order`, () => {
      expect(enumColumns[column as keyof typeof enumColumns]).toEqual(expected);
    });
  }

  it('retains the values §7.2 and §7.4 reserve but do not use in v1', () => {
    expect(enumColumns.bundle_inclusion_policy).toContain('snapshot_at_purchase');
    expect(enumColumns.renewal_type).toContain('auto');
  });
});

describe('zod schemas', () => {
  it('accepts every specified value and rejects anything else', () => {
    for (const [column, expected] of Object.entries(specifiedIn_8_1)) {
      const schemaName = `${column.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())}Schema`;
      const schema = (shared as Record<string, unknown>)[schemaName];
      expect(schema, `missing export ${schemaName}`).toBeDefined();
      const parse = (schema as { safeParse: (v: unknown) => { success: boolean } }).safeParse;
      for (const value of expected) {
        expect(parse(value).success, `${schemaName} rejected ${value}`).toBe(true);
      }
      expect(parse('definitely_not_a_member').success).toBe(false);
      expect(parse('').success).toBe(false);
    }
  });
});
