/**
 * build-codes — extracts the integer code -> label maps for the collision table from the
 * DfT data guide (data/raw/data-guide-2025.xlsx) and writes shared/codes.json.
 *
 *   npm run build-codes
 *
 * The result is committed so a clean clone has it without running this. The browser uses
 * it to decode coded columns in the results table (display layer only): a query still
 * emits `weather_conditions` (an integer), and the table shows "1 — Fine no high winds".
 * This keeps the generated SQL clean and editable while the output reads in English.
 *
 * Only columns that (a) have codes in the guide AND (b) exist in the committed schema are
 * included, so historic/renamed guide fields that aren't in the 2025 data are skipped.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DuckDBInstance } from '@duckdb/node-api';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GUIDE = join(ROOT, 'data', 'raw', 'data-guide-2025.xlsx');
const SCHEMA_FILE = join(ROOT, 'shared', 'schema.json');
const OUT = join(ROOT, 'shared', 'codes.json');

const sqlPath = (p) => p.replaceAll('\\', '/');

async function main() {
  const schema = JSON.parse(await readFile(SCHEMA_FILE, 'utf8'));
  const collisions = schema.tables.find((t) => t.name === 'collisions');
  if (!collisions) throw new Error('collisions table not found in schema.json');
  const schemaColumns = new Set(collisions.columns.map((c) => c.name));

  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  await conn.run('INSTALL excel');
  await conn.run('LOAD excel');

  const reader = await conn.runAndReadAll(
    `SELECT "field name" AS field, "code/format" AS code, label
     FROM read_xlsx('${sqlPath(GUIDE)}', all_varchar = true)
     WHERE "table" = 'collision' AND "code/format" IS NOT NULL AND label IS NOT NULL
     ORDER BY field, try_cast("code/format" AS INTEGER)`,
  );

  const columns = {};
  let skipped = 0;
  for (const row of reader.getRowObjects()) {
    const field = String(row.field);
    if (!schemaColumns.has(field)) {
      skipped += 1;
      continue;
    }
    (columns[field] ??= {})[String(row.code)] = String(row.label);
  }

  const out = {
    generated_at: new Date().toISOString(),
    source: 'DfT road safety data guide (Open Government Licence v3.0)',
    table: 'collisions',
    columns,
  };
  await writeFile(OUT, `${JSON.stringify(out, null, 2)}\n`);

  const fieldCount = Object.keys(columns).length;
  const codeCount = Object.values(columns).reduce((n, m) => n + Object.keys(m).length, 0);
  console.log(`wrote ${OUT.replace(ROOT, '.')}: ${fieldCount} coded columns, ${codeCount} codes`);
  console.log(`(skipped ${skipped} guide rows for columns not in the committed schema)`);
  console.log('coded columns:', Object.keys(columns).join(', '));
}

main().catch((err) => {
  console.error(`build-codes failed: ${err.message}`);
  process.exitCode = 1;
});
