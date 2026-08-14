/**
 * prepare-data — rebuilds the dataset artefacts that this repo ships committed.
 *
 * A reviewer does NOT need to run this. `public/data/collisions.parquet` and
 * `shared/schema.json` are committed so a clean clone has no network step on the
 * critical path (see PLAN.md, "Data handling"). This script exists so those two
 * files are reproducible and their provenance is written down rather than folklore.
 *
 *   npm run prepare-data                       # collisions only (the v1 dataset)
 *   npm run prepare-data -- --tables=collision,vehicle,casualty
 *   npm run prepare-data -- --year=2024 --force
 *
 * Source: Department for Transport, "Road Safety Data" (GOV.UK / data.gov.uk),
 * published under the Open Government Licence v3.0. Raw CSVs land in data/raw/
 * (gitignored); only the derived Parquet is committed.
 *
 * What this deliberately does NOT do: it does not decode the integer category
 * codes (1 = Fatal, 2 = Serious, …) into labels. Those codes live in the DfT data
 * guide, and keeping them coded is what makes retrieval load-bearing rather than
 * decorative — the model cannot answer "how many fatal collisions" without the
 * snippets. See PLAN.md, "Assumptions".
 */

import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { DuckDBInstance } from '@duckdb/node-api';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RAW_DIR = join(ROOT, 'data', 'raw');
const PARQUET_DIR = join(ROOT, 'public', 'data');
const SCHEMA_FILE = join(ROOT, 'shared', 'schema.json');

const BASE_URL = 'https://data.dft.gov.uk/road-accidents-safety-data';
const LICENCE = 'Open Government Licence v3.0';
const ATTRIBUTION = 'Department for Transport — Road Safety Data (data.gov.uk)';

/**
 * The data guide is the .xlsx that maps every coded column to its labels. It is
 * the source material for the retrieval snippets, not an input to the Parquet,
 * so it is downloaded but never converted — and a missing guide warns rather than
 * fails the run.
 *
 * DfT versions this file by year and deletes the previous one; the link published
 * on data.gov.uk currently points at the 2024 name and 404s. So we try recent years
 * newest-first instead of hard-coding one URL.
 */
const dataGuideCandidateYears = () => {
  const thisYear = new Date().getFullYear();
  return [0, 1, 2].map((back) => thisYear - back);
};
const dataGuideUrl = (year) =>
  `${BASE_URL}/dft-road-casualty-statistics-road-safety-open-dataset-data-guide-${year}.xlsx`;

/**
 * The three DfT tables. `collision` is v1; the other two are staged for the joins
 * conversation and join back on `collision_index`. `name` is what the browser
 * registers the Parquet as and therefore what generated SQL must say, so it is
 * written out rather than pluralised in code.
 */
const TABLES = {
  collision: { name: 'collisions', parquet: 'collisions.parquet', grain: 'one row per reported collision' },
  vehicle: { name: 'vehicles', parquet: 'vehicles.parquet', grain: 'one row per vehicle involved in a collision' },
  casualty: { name: 'casualties', parquet: 'casualties.parquet', grain: 'one row per injured casualty' },
};

/**
 * Column type overrides applied at read time. Everything else is left to DuckDB's
 * sniffer, which reads the coded categoricals as BIGINT — correct, and what we want.
 *
 * The two identifier columns MUST be forced to VARCHAR: `collision_ref_no` carries
 * significant leading zeros (070815222) and `collision_index` is mixed alphanumeric
 * (202517H102225). A sniffer that guesses BIGINT on a sample of all-numeric rows
 * silently corrupts both.
 */
const FORCED_VARCHAR = [
  'collision_index',
  'collision_ref_no',
  'accident_index',
  'accident_reference',
  // date/time are read as text and cast explicitly below, never sniffed — see DATE_CASTS.
  'date',
  'time',
];

/**
 * DfT ships `date` as DD/MM/YYYY and `time` as HH:MM, both as text. DuckDB's sniffer
 * will often guess the format correctly, but "05/03/2025" is genuinely ambiguous and a
 * sniffer that lands on %m/%d/%Y silently moves March into May — a semantic bug that
 * every downstream query inherits and no test of the SQL itself would catch. So the two
 * columns are read as VARCHAR and cast here with the format stated outright.
 */
const DATE_CASTS = [
  `strptime("date", '%d/%m/%Y')::DATE AS "date"`,
  `try_cast("time" AS TIME) AS "time"`,
];

function parseArgs(argv) {
  const args = { year: 2025, tables: ['collision'], force: false };
  for (const arg of argv) {
    if (arg === '--force') args.force = true;
    else if (arg.startsWith('--year=')) args.year = Number(arg.slice('--year='.length));
    else if (arg.startsWith('--tables=')) args.tables = arg.slice('--tables='.length).split(',').map((t) => t.trim());
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(args.year)) throw new Error('--year must be an integer, e.g. --year=2025');
  for (const table of args.tables) {
    if (!TABLES[table]) throw new Error(`Unknown table "${table}". Known: ${Object.keys(TABLES).join(', ')}`);
  }
  return args;
}

const log = (msg) => console.log(msg);
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const sqlPath = (p) => p.replaceAll('\\', '/');

async function fileSize(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

/** Downloads to a .part file and renames, so an interrupted run never leaves a truncated CSV behind. */
async function download(url, destPath, { force }) {
  const existing = await fileSize(destPath);
  if (existing !== null && !force) {
    log(`  cached  ${destPath.replace(ROOT, '.')} (${mb(existing)}) — use --force to re-download`);
    return;
  }

  log(`  GET     ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);

  const partPath = `${destPath}.part`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(partPath));
  await rm(destPath, { force: true });
  await rename(partPath, destPath);
  log(`  saved   ${destPath.replace(ROOT, '.')} (${mb(await fileSize(destPath))})`);
}

/**
 * Returns the URL that actually resolved, so the schema snapshot can record which
 * edition of the guide the snippets were written from. The year stays in the local
 * filename for the same reason — a bare `data-guide.xlsx` on disk tells you nothing.
 */
async function downloadDataGuide({ force }) {
  for (const year of dataGuideCandidateYears()) {
    const url = dataGuideUrl(year);
    try {
      await download(url, join(RAW_DIR, `data-guide-${year}.xlsx`), { force });
      return { year, url };
    } catch (err) {
      log(`  miss    ${url} (${err.message.split(' for ')[0]})`);
    }
  }
  log(`  WARN    no data guide found — snippets can still be written by hand; the Parquet is unaffected`);
  return null;
}

/** Reads the CSV header so the type overrides only name columns that actually exist. */
async function headerColumns(connection, csvPath) {
  const reader = await connection.runAndReadAll(
    `DESCRIBE SELECT * FROM read_csv('${sqlPath(csvPath)}', header = true, sample_size = 1024)`,
  );
  return reader.getRowObjects().map((r) => String(r.column_name));
}

function buildSelect(columns) {
  const forced = FORCED_VARCHAR.filter((c) => columns.includes(c));
  const casts = DATE_CASTS.filter((c) => columns.includes(c.match(/AS "(\w+)"$/)[1]));
  const replace = casts.length ? ` REPLACE (${casts.join(', ')})` : '';
  return { forced, select: `SELECT *${replace}` };
}

async function convert(connection, { table, year, force }) {
  const csvPath = join(RAW_DIR, `dft-road-casualty-statistics-${table}-${year}.csv`);
  const parquetPath = join(PARQUET_DIR, TABLES[table].parquet);

  await download(`${BASE_URL}/dft-road-casualty-statistics-${table}-${year}.csv`, csvPath, { force });

  const columns = await headerColumns(connection, csvPath);
  const { forced, select } = buildSelect(columns);
  const typeOverride = forced.length
    ? `, types = {${forced.map((c) => `'${c}': 'VARCHAR'`).join(', ')}}`
    : '';
  const source = `read_csv('${sqlPath(csvPath)}', header = true, sample_size = -1${typeOverride})`;

  log(`  convert ${table}: forcing VARCHAR on [${forced.join(', ') || 'none'}], casting date/time`);
  await connection.run(
    `COPY (${select} FROM ${source}) TO '${sqlPath(parquetPath)}' ` +
      `(FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)`,
  );

  const csvBytes = await fileSize(csvPath);
  const parquetBytes = await fileSize(parquetPath);
  log(`  wrote   ${parquetPath.replace(ROOT, '.')} (${mb(parquetBytes)}, from ${mb(csvBytes)} CSV)`);

  return { table, parquetPath, parquetBytes };
}

/**
 * The schema snapshot is the ONLY thing about the dataset the Worker (and therefore
 * the LLM) ever sees. Column names and types, plus two dataset-level facts —
 * row count and date range — that are already published by DfT and that the model
 * needs to avoid inventing a time window. No values, no samples, no cardinalities:
 * anything that would let the model infer the contents of a row stays out.
 */
async function buildSchema(connection, outputs, { year, tables, dataGuide }) {
  const snapshot = {
    generated_at: new Date().toISOString(),
    source: {
      name: ATTRIBUTION,
      licence: LICENCE,
      base_url: BASE_URL,
      year,
      // Which edition of the coded-value guide the snippets were written against.
      // DfT deletes older editions, so the URL may 404 later even though it resolved here.
      data_guide: dataGuide ?? null,
    },
    dialect: 'duckdb',
    tables: [],
  };

  for (const { table, parquetPath, parquetBytes } of outputs) {
    const from = `read_parquet('${sqlPath(parquetPath)}')`;
    const describe = await connection.runAndReadAll(`DESCRIBE SELECT * FROM ${from}`);
    const columns = describe.getRowObjects().map((r) => ({
      name: String(r.column_name),
      type: String(r.column_type),
    }));

    const hasDate = columns.some((c) => c.name === 'date');
    const stats = await connection.runAndReadAll(
      `SELECT count(*)::BIGINT AS row_count` +
        (hasDate ? `, min("date")::VARCHAR AS min_date, max("date")::VARCHAR AS max_date` : '') +
        ` FROM ${from}`,
    );
    const [row] = stats.getRowObjects();

    snapshot.tables.push({
      name: TABLES[table].name,
      grain: TABLES[table].grain,
      file: `/data/${TABLES[table].parquet}`,
      file_bytes: parquetBytes,
      row_count: Number(row.row_count),
      ...(hasDate ? { date_range: [row.min_date, row.max_date] } : {}),
      columns,
    });
  }

  await mkdir(dirname(SCHEMA_FILE), { recursive: true });
  await writeFile(SCHEMA_FILE, `${JSON.stringify(snapshot, null, 2)}\n`);
  log(`  wrote   ${SCHEMA_FILE.replace(ROOT, '.')} (${tables.length} table(s))`);
  return snapshot;
}

/** Cheap guards on the assumptions PLAN.md makes about this data. */
function check(snapshot, { year }) {
  const problems = [];
  for (const table of snapshot.tables) {
    if (table.row_count === 0) problems.push(`${table.name}: zero rows`);
    if (table.file_bytes > 50 * 1024 * 1024) {
      problems.push(`${table.name}: ${mb(table.file_bytes)} exceeds the 50 MB in-browser budget`);
    }
    if (table.date_range && !table.date_range.every((d) => d.startsWith(String(year)))) {
      problems.push(`${table.name}: date range ${table.date_range.join(' → ')} escapes ${year}`);
    }
    const dateCol = table.columns.find((c) => c.name === 'date');
    if (dateCol && dateCol.type !== 'DATE') problems.push(`${table.name}: date is ${dateCol.type}, expected DATE`);
  }
  return problems;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  log(`\nprepare-data — DfT road safety ${args.year}: ${args.tables.join(', ')}\n`);

  await mkdir(RAW_DIR, { recursive: true });
  await mkdir(PARQUET_DIR, { recursive: true });

  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();

  const dataGuide = await downloadDataGuide(args);

  const outputs = [];
  for (const table of args.tables) {
    outputs.push(await convert(connection, { table, year: args.year, force: args.force }));
  }

  const snapshot = await buildSchema(connection, outputs, { ...args, dataGuide });

  log('');
  for (const table of snapshot.tables) {
    const range = table.date_range ? `, ${table.date_range[0]} → ${table.date_range[1]}` : '';
    log(`  ${table.name}: ${table.row_count.toLocaleString('en-GB')} rows, ${table.columns.length} columns${range}`);
  }

  const problems = check(snapshot, args);
  if (problems.length) {
    log(`\nFAILED sanity checks:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  log('\nOK — sanity checks passed. Commit public/data/*.parquet and shared/schema.json.\n');
}

main().catch((err) => {
  console.error(`\nprepare-data failed: ${err.message}\n`);
  process.exitCode = 1;
});