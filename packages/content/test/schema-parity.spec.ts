import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { errorCodes } from '@knowledge-explorer/shared';
import {
  buildJsonSchema,
  SCHEMA_VERSION,
  validateImportPayload,
} from '../src/import-schema';

/**
 * FR-IMP-03 versions the prompt template alongside the schema. Three artifacts
 * must agree — the zod module, docs/import-schema.json and
 * docs/owner-prompt-template.md — and this suite is what stops them drifting.
 */

const docs = resolve(process.cwd(), '../../docs');
const committedJsonSchema = JSON.parse(readFileSync(resolve(docs, 'import-schema.json'), 'utf8'));
const template = readFileSync(resolve(docs, 'owner-prompt-template.md'), 'utf8');

/** The first fenced json block in the template: the example an owner copies. */
function templateExample(): unknown {
  const match = /```json\n([\s\S]*?)\n```/.exec(template);
  expect(match, 'the template must contain a fenced json example').not.toBeNull();
  return JSON.parse(match![1]!);
}

describe('docs/import-schema.json', () => {
  it('is exactly what the zod schema generates', () => {
    // Regenerate with: pnpm --filter @knowledge-explorer/content run docs:schema
    expect(committedJsonSchema).toEqual(buildJsonSchema());
  });

  it('requires the four top-level members of §9.1 plus schemaVersion', () => {
    expect(committedJsonSchema.required).toEqual([
      'schemaVersion',
      'category',
      'course',
      'chapters',
    ]);
  });

  it('rejects unknown keys rather than ignoring them (FR-IMP-01: strict)', () => {
    expect(committedJsonSchema.additionalProperties).toBe(false);
  });
});

describe('docs/owner-prompt-template.md', () => {
  it('declares the schema version the server ships', () => {
    const declared = /\*\*schemaVersion:\s*([^*\s]+)\*\*/.exec(template);
    expect(declared, 'the template must declare its schemaVersion').not.toBeNull();
    expect(declared![1]).toBe(SCHEMA_VERSION);
  });

  it('carries an example that actually validates — the point of FR-IMP-03', () => {
    const result = validateImportPayload(templateExample());
    expect(result.ok, result.ok ? '' : JSON.stringify(result.issues, null, 2)).toBe(true);
  });
});

describe('validateImportPayload', () => {
  const valid = () => structuredClone(templateExample()) as Record<string, unknown>;

  it('accepts the §9.1 shape', () => {
    expect(validateImportPayload(valid()).ok).toBe(true);
  });

  it('reports a stale schemaVersion as one error naming both versions', () => {
    const payload = { ...valid(), schemaVersion: '0.9.0' };
    const result = validateImportPayload(payload);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe(errorCodes.IMPORT_SCHEMA_VERSION_MISMATCH);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.path).toBe('schemaVersion');
    expect(result.issues[0]!.message).toContain('0.9.0');
    expect(result.issues[0]!.message).toContain(SCHEMA_VERSION);
  });

  it('gates the version before field validation, so a stale template is not buried', () => {
    // Same payload, also structurally broken. The version error must win alone.
    const result = validateImportPayload({ schemaVersion: '0.9.0' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe(errorCodes.IMPORT_SCHEMA_VERSION_MISMATCH);
    expect(result.issues).toHaveLength(1);
  });

  it('reports EVERY field error with its JSON path, not just the first', () => {
    const payload = valid();
    (payload['category'] as Record<string, unknown>)['slug'] = 'Not A Slug';
    (payload['course'] as Record<string, unknown>)['levelOrder'] = 0;
    const chapters = payload['chapters'] as Array<Record<string, unknown>>;
    (chapters[0]!['lessons'] as Array<Record<string, unknown>>)[0]!['title'] = '';

    const result = validateImportPayload(payload);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe(errorCodes.IMPORT_PAYLOAD_INVALID);
    expect(result.issues.map((issue) => issue.path).sort()).toEqual([
      'category.slug',
      'chapters[0].lessons[0].title',
      'course.levelOrder',
    ]);
  });

  it('rejects an unknown key with the path that carries it', () => {
    const payload = { ...valid(), lessonBodies: ['nope'] };
    const result = validateImportPayload(payload);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.path)).toContain('lessonBodies');
  });

  it('rejects a duplicate chapterOrder, naming the earlier chapter', () => {
    const payload = valid();
    const chapters = payload['chapters'] as Array<Record<string, unknown>>;
    chapters.push(structuredClone(chapters[0]!));

    const result = validateImportPayload(payload);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]!.path).toBe('chapters[1].chapterOrder');
    expect(result.issues[0]!.message).toContain('chapters[0]');
  });

  it('rejects a duplicate lessonOrder within one chapter', () => {
    const payload = valid();
    const chapters = payload['chapters'] as Array<Record<string, unknown>>;
    const lessons = chapters[0]!['lessons'] as Array<Record<string, unknown>>;
    lessons.push(structuredClone(lessons[0]!));

    const result = validateImportPayload(payload);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]!.path).toBe('chapters[0].lessons[1].lessonOrder');
  });

  it('applies §8 defaults for the members the payload may omit', () => {
    const payload = valid();
    const course = payload['course'] as Record<string, unknown>;
    delete course['languageCode'];
    delete course['prerequisites'];

    const result = validateImportPayload(payload);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.course.languageCode).toBe('vi');
    expect(result.payload.course.prerequisites).toEqual([]);
  });
});

describe('validateImportPayload — slug derivation', () => {
  it('rejects a levelLabel that yields no slug, at its JSON path', () => {
    const payload = JSON.parse(
      readFileSync(resolve(docs, 'owner-prompt-template.md'), 'utf8').match(
        /```json\n([\s\S]*?)\n```/,
      )![1]!,
    ) as Record<string, unknown>;
    (payload['course'] as Record<string, unknown>)['levelLabel'] = '初級';

    const result = validateImportPayload(payload);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe(errorCodes.IMPORT_PAYLOAD_INVALID);
    expect(result.issues[0]!.path).toBe('course.levelLabel');
  });
});
