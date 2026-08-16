/**
 * golden-harness — the end-to-end evaluation of the whole pipeline.
 *
 *   # start the Worker first (needs Cloudflare auth): npm run worker
 *   npm run golden-harness
 *
 * For each question in shared/golden.json it:
 *   1. calls the LIVE Worker (/api/generate-sql) to get the model's SQL,
 *   2. runs the model's SQL and the reference SQL against the committed Parquet,
 *   3. compares result sets — strict for `exact`, column+row count for `shape`,
 *      manual (reported, not graded) for `fuzzy`,
 *   4. does all of the above twice: context-on and context-off (the retrieval A/B).
 *
 * Prints a Markdown table to paste into VERIFICATION.md and writes the full detail
 * (including the model SQL per arm) to shared/golden-results.json. The model is
 * non-deterministic, so results are a snapshot; re-run for a fresh one.
 *
 * Env: WORKER_URL overrides the Worker origin (default http://127.0.0.1:8787).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DuckDBInstance } from '@duckdb/node-api';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN = join(ROOT, 'shared', 'golden.json');
const PARQUET = join(ROOT, 'public', 'data', 'collisions.parquet');
const OUT = join(ROOT, 'shared', 'golden-results.json');
const WORKER = process.env.WORKER_URL ?? 'http://127.0.0.1:8787';

const sqlPath = (p) => p.replaceAll('\\', '/');
const jsonSafe = (v) => (typeof v === 'bigint' ? Number(v) : v);

// Canonical form of a result set: values per row (column order preserved), numbers
// rounded to absorb float noise, rows sorted so ordering differences don't matter.
function canon(rows) {
  const norm = rows.map((r) =>
    Object.values(r).map((v) => {
      if (typeof v === 'bigint') return Number(v);
      if (typeof v === 'number') return Math.round(v * 10000) / 10000;
      return v === null || v === undefined ? null : String(v);
    }),
  );
  norm.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  return JSON.stringify(norm);
}

async function main() {
  const golden = JSON.parse(await readFile(GOLDEN, 'utf8'));
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  await conn.run(`CREATE VIEW collisions AS SELECT * FROM read_parquet('${sqlPath(PARQUET)}')`);

  const runSql = async (sql) => {
    const reader = await conn.runAndReadAll(sql);
    return reader.getRowObjects().map((row) => {
      const o = {};
      for (const [k, v] of Object.entries(row)) o[k] = jsonSafe(v);
      return o;
    });
  };

  // Ask the live Worker for SQL; retry generation errors (flaky/truncated), never wrong answers.
  const generate = async (question, withContext) => {
    let lastErr = '';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const res = await fetch(`${WORKER}/api/generate-sql`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ question, withContext }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
        if (typeof data.sql !== 'string') throw new Error('no sql in response');
        return { sql: data.sql };
      } catch (err) {
        lastErr = err.message;
      }
    }
    return { error: lastErr };
  };

  const results = [];

  for (const q of golden.questions) {
    const refRows = await runSql(q.reference_sql);
    const refCanon = canon(refRows);
    const refCols = refRows.length ? Object.keys(refRows[0]).length : 0;

    const runArm = async (withContext) => {
      const gen = await generate(q.question, withContext);
      if (gen.error) return { status: 'GEN-ERR', detail: gen.error };
      let modelRows;
      try {
        modelRows = await runSql(gen.sql);
      } catch (err) {
        return { status: 'SQL-ERR', sql: gen.sql, detail: String(err.message).split('\n')[0] };
      }
      const cols = modelRows.length ? Object.keys(modelRows[0]).length : 0;
      let status;
      if (q.kind === 'fuzzy') status = 'FUZZY';
      else if (q.kind === 'shape') status = cols === refCols && modelRows.length === refRows.length ? 'PASS' : 'FAIL';
      else status = canon(modelRows) === refCanon ? 'PASS' : 'FAIL';
      return { status, sql: gen.sql, rowCount: modelRows.length };
    };

    const on = await runArm(true);
    const off = await runArm(false);
    results.push({ id: q.id, kind: q.kind, has_example: q.has_example, on, off });
    console.log(`  ${q.id.padEnd(30)} on=${on.status.padEnd(8)} off=${off.status}`);
  }

  // --- Markdown table for VERIFICATION.md ---
  console.log('\n\n### Golden harness results\n');
  console.log(`Worker: ${WORKER} · model is non-deterministic (snapshot).\n`);
  console.log('| id | kind | has_example | context-on | context-off |');
  console.log('| --- | --- | --- | --- | --- |');
  for (const r of results) {
    console.log(`| ${r.id} | ${r.kind} | ${r.has_example ? 'yes' : 'no'} | ${r.on.status} | ${r.off.status} |`);
  }

  // --- A/B summary (exact + shape questions only; fuzzy is manual) ---
  const graded = results.filter((r) => r.kind !== 'fuzzy');
  const onPass = graded.filter((r) => r.on.status === 'PASS').length;
  const offPass = graded.filter((r) => r.off.status === 'PASS').length;
  const improved = graded.filter((r) => r.on.status === 'PASS' && r.off.status !== 'PASS').length;
  console.log(`\nGraded (non-fuzzy): ${graded.length}`);
  console.log(`  context-on  PASS: ${onPass}/${graded.length}`);
  console.log(`  context-off PASS: ${offPass}/${graded.length}`);
  console.log(`  retrieval improved (on PASS, off not): ${improved}`);

  await writeFile(OUT, `${JSON.stringify({ generated_at: new Date().toISOString(), worker: WORKER, results }, null, 2)}\n`);
  console.log(`\nwrote ${OUT.replace(ROOT, '.')}\n`);
}

main().catch((err) => {
  console.error(`\ngolden-harness failed: ${err.message}\n`);
  process.exitCode = 1;
});
