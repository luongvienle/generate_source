import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildJsonSchema, SCHEMA_VERSION } from '../src/import-schema';

/**
 * Regenerates docs/import-schema.json from the zod schema.
 *
 * The committed file is what GET /api/admin/import-schema serves and what
 * owners validate against; schema-parity.spec.ts fails when it drifts from the
 * module, and this script is how you make it agree again.
 */
const target = resolve(process.cwd(), '../../docs/import-schema.json');
writeFileSync(target, `${JSON.stringify(buildJsonSchema(), null, 2)}\n`);
console.log(`Wrote ${target} (schemaVersion ${SCHEMA_VERSION})`);
