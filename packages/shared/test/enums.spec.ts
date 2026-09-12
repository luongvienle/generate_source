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

/**
 * NOT from §8.1 — that table catalogues no members for generation_jobs.job_status.
 * These are decided by specs/p1-curriculum/spec.md and kept in their own table so
 * the transcription above stays an honest record of what the product spec fixes.
 */
const decidedInP1: Record<string, readonly string[]> = {
  job_status: ['queued', 'running', 'succeeded', 'failed'],
};

const everyColumn: Record<string, readonly string[]> = { ...specifiedIn_8_1, ...decidedInP1 };

describe('§8.1 enum-like columns', () => {
  it('covers every catalogued column, and no extras', () => {
    expect(Object.keys(enumColumns).sort()).toEqual(Object.keys(everyColumn).sort());
  });

  it('catalogues 16 columns across the 15 rows of §8.1, plus job_status from P1', () => {
    // script_status and audio_status share one row in the spec table.
    expect(Object.keys(specifiedIn_8_1)).toHaveLength(16);
    expect(Object.keys(enumColumns)).toHaveLength(17);
    expect(enumColumns.script_status).toEqual(enumColumns.audio_status);
  });

  for (const [column, expected] of Object.entries(specifiedIn_8_1)) {
    it(`${column} allows exactly the values §8.1 lists, in order`, () => {
      expect(enumColumns[column as keyof typeof enumColumns]).toEqual(expected);
    });
  }

  for (const [column, expected] of Object.entries(decidedInP1)) {
    it(`${column} allows exactly the values P1 decided, in order`, () => {
      expect(enumColumns[column as keyof typeof enumColumns]).toEqual(expected);
    });
  }

  it('keeps job_status distinct from the script/audio vocabulary — a job is never stale', () => {
    expect(enumColumns.job_status).not.toContain('stale');
    expect(enumColumns.job_status[0]).toBe('queued'); // §8's declared column default
  });

  it('retains the values §7.2 and §7.4 reserve but do not use in v1', () => {
    expect(enumColumns.bundle_inclusion_policy).toContain('snapshot_at_purchase');
    expect(enumColumns.renewal_type).toContain('auto');
  });
});

describe('zod schemas', () => {
  it('accepts every specified value and rejects anything else', () => {
    for (const [column, expected] of Object.entries(everyColumn)) {
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
