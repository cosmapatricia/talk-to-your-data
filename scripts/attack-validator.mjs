/**
 * attack-validator — runs the SQL validator (src/validate.ts) against an adversarial
 * suite and prints a pass/fail table. This IS the "attack your own validator" deliverable.
 *
 *   npm run attack-validator
 *
 * The validator uses DuckDB's own parser (json_serialize_sql). Node DuckDB and the
 * browser's DuckDB-WASM share that parser, so the results here match the browser's guard.
 * json_serialize_sql is parse-only (no catalog binding), so the referenced tables need
 * not exist. Exit code is non-zero if any case does not match its expectation.
 */
import { DuckDBInstance } from '@duckdb/node-api';

import { validateSql } from '../src/validate.ts';

const instance = await DuckDBInstance.create(':memory:');
const conn = await instance.connect();

const serialize = async (sql) => {
  const escaped = sql.replaceAll("'", "''");
  const reader = await conn.runAndReadAll(`SELECT json_serialize_sql('${escaped}') AS j`);
  return JSON.parse(String(reader.getRowObjects()[0].j));
};

// expect: 'allow' = a legitimate read-only query the guard must permit;
//         'block' = an attack the guard must reject.
const cases = [
  // --- legitimate queries (must ALLOW) ---
  ['allow', 'plain SELECT', 'SELECT count(*) FROM collisions'],
  ['allow', 'CTE', 'WITH x AS (SELECT collision_severity FROM collisions) SELECT count(*) FROM x'],
  ['allow', 'subquery', 'SELECT (SELECT count(*) FROM collisions) AS n'],
  ['allow', 'FILTER + GROUP BY', 'SELECT day_of_week, count(*) FILTER (WHERE collision_severity = 1) AS fatal FROM collisions GROUP BY 1'],
  ['allow', 'line comment', 'SELECT count(*) FROM collisions -- a comment'],
  ['allow', 'block comment', 'SELECT count(*) /* inline */ FROM collisions'],
  ['allow', 'trailing semicolon', 'SELECT count(*) FROM collisions;'],

  // --- statement-type attacks (must BLOCK; caught by "SELECT only") ---
  ['block', 'DROP', 'DROP TABLE collisions'],
  ['block', 'DELETE', 'DELETE FROM collisions'],
  ['block', 'UPDATE', "UPDATE collisions SET collision_severity = 3"],
  ['block', 'INSERT', 'INSERT INTO collisions VALUES (1)'],
  ['block', 'CREATE', 'CREATE TABLE t AS SELECT 1'],
  ['block', 'ATTACH', "ATTACH 'evil.db' AS e"],
  ['block', 'COPY TO', "COPY collisions TO 'out.csv'"],
  ['block', 'COPY (SELECT) TO', "COPY (SELECT * FROM collisions) TO 'out.csv' (FORMAT CSV)"],
  ['block', 'INSTALL', 'INSTALL httpfs'],
  ['block', 'LOAD', 'LOAD httpfs'],
  ['block', 'PRAGMA', 'PRAGMA database_list'],
  ['block', 'SET', 'SET threads = 1'],
  ['block', 'CALL', "CALL pragma_table_info('collisions')"],

  // --- stacked-statement attacks (must BLOCK) ---
  ['block', 'stacked drop', 'SELECT 1; DROP TABLE collisions'],
  ['block', 'stacked select', 'SELECT 1; SELECT 2'],
  ['block', 'comment-hidden stacked', 'SELECT 1 -- harmless\n; DROP TABLE collisions'],
  ['block', 'block-comment-hidden stacked', 'SELECT 1 /* ; DROP TABLE collisions */; DROP TABLE collisions'],

  // --- file/network function attacks inside a SELECT (must BLOCK; caught by AST walk) ---
  ['block', 'read_csv url', "SELECT * FROM read_csv('http://evil.example/x.csv')"],
  ['block', 'read_parquet', "SELECT * FROM read_parquet('secret.parquet')"],
  ['block', 'read_text', "SELECT read_text('/etc/passwd')"],
  ['block', 'read_blob', "SELECT read_blob('/etc/passwd')"],
  ['block', 'glob', "SELECT * FROM glob('/**')"],
  ['block', 'read_csv in subquery', "SELECT (SELECT count(*) FROM read_csv('http://evil/x')) AS n"],
  ['block', 'read_csv in CTE', "WITH e AS (SELECT * FROM read_csv('http://evil/x')) SELECT * FROM e"],
];

const width = Math.max(...cases.map(([, label]) => label.length));
let mismatches = 0;

console.log(`\n${'EXPECT'.padEnd(6)}  ${'GOT'.padEnd(6)}  ${'label'.padEnd(width)}  detail`);
console.log('-'.repeat(width + 40));

for (const [expect, label, sql] of cases) {
  const verdict = await validateSql(sql, serialize);
  const got = verdict.ok ? 'allow' : 'block';
  const match = got === expect;
  if (!match) mismatches += 1;
  const mark = match ? ' ' : 'X';
  const detail = verdict.ok ? '' : verdict.message ?? '';
  console.log(`${mark} ${expect.padEnd(6)} ${got.padEnd(6)}  ${label.padEnd(width)}  ${detail}`);
}

console.log('-'.repeat(width + 40));
if (mismatches) {
  console.log(`\nFAILED: ${mismatches} case(s) did not match expectation.\n`);
  process.exitCode = 1;
} else {
  console.log(`\nOK — all ${cases.length} cases matched expectation.\n`);
}
