/**
 * verify-golden — runs each golden-set reference SQL against the committed Parquet
 * and captures the expected results.
 *
 *   npm run verify-golden
 *
 * Two jobs:
 *   1. Sanity-check that the hand-authored reference SQL (the oracle the harness
 *      compares model output against) actually runs and returns sensible rows.
 *   2. Write shared/golden-expected.json — a committed snapshot of expected results,
 *      so the golden set has an "expected shape / value" per question even before the
 *      Worker exists. Once the Worker is built, the full harness will compare the
 *      model's SQL result to these references; this script is the reference half.
 *
 * It runs the SQL directly in Node DuckDB against public/data/collisions.parquet, the
 * same file the browser loads — no model, no Worker.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DuckDBInstance } from '@duckdb/node-api';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN = join(ROOT, 'shared', 'golden.json');
const PARQUET = join(ROOT, 'public', 'data', 'collisions.parquet');
const OUT = join(ROOT, 'shared', 'golden-expected.json');
const EXPECTED_ROWS = 101525; // must match shared/schema.json

const sqlPath = (p) => p.replaceAll('\\', '/');
// DuckDB returns BIGINT as JS BigInt, which JSON.stringify can't serialise.
const jsonSafe = (v) => (typeof v === 'bigint' ? Number(v) : v);

async function main() {
  const golden = JSON.parse(await readFile(GOLDEN, 'utf8'));
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  await conn.run(
    `CREATE VIEW collisions AS SELECT * FROM read_parquet('${sqlPath(PARQUET)}')`,
  );

  // Sanity: the browser and this checker must see the same file.
  const [{ n }] = (await conn.runAndReadAll('SELECT count(*)::INT AS n FROM collisions')).getRowObjects();
  const rowsOk = Number(n) === EXPECTED_ROWS;
  console.log(`collisions rows: ${Number(n).toLocaleString('en-GB')} ${rowsOk ? '(OK)' : `(EXPECTED ${EXPECTED_ROWS})`}\n`);

  const expected = { generated_at: new Date().toISOString(), table: golden.table, results: {} };
  let failures = 0;

  for (const q of golden.questions) {
    try {
      const reader = await conn.runAndReadAll(q.reference_sql);
      const rows = reader.getRowObjects().map((row) => {
        const out = {};
        for (const [k, v] of Object.entries(row)) out[k] = jsonSafe(v);
        return out;
      });
      expected.results[q.id] = { kind: q.kind, columns: reader.columnNames(), row_count: rows.length, rows };
      const preview = rows.length <= 3 ? JSON.stringify(rows) : `${rows.length} rows, first ${JSON.stringify(rows[0])}`;
      console.log(`  [${q.kind.padEnd(5)}] ${q.id}: ${preview}`);
    } catch (err) {
      failures += 1;
      console.log(`  [FAIL ] ${q.id}: ${err.message}`);
    }
  }

  await writeFile(OUT, `${JSON.stringify(expected, null, 2)}\n`);
  console.log(`\nwrote ${OUT.replace(ROOT, '.')} (${Object.keys(expected.results).length} results)`);

  if (!rowsOk || failures) {
    console.log(`\nFAILED: ${failures} reference query error(s)${rowsOk ? '' : ', row-count mismatch'}\n`);
    process.exitCode = 1;
  } else {
    console.log('\nOK — all reference queries ran.\n');
  }
}

main().catch((err) => {
  console.error(`\nverify-golden failed: ${err.message}\n`);
  process.exitCode = 1;
});
