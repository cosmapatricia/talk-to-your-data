import * as duckdb from '@duckdb/duckdb-wasm';
import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';

// Single-thread bundles only (mvp / eh). We deliberately omit the coi (threaded)
// bundle: it needs SharedArrayBuffer and COOP/COEP cross-origin isolation, which is
// friction we don't need at ~4 MB / 100k rows. All assets are bundled locally by
// Vite (the `?url` imports), so there is NO runtime network dependency — matching
// the committed-Parquet decision in PLAN.md ("commit the Parquet, no fetch on the
// critical path").
const BUNDLES: duckdb.DuckDBBundles = {
  mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
  eh: { mainModule: ehWasm, mainWorker: ehWorker },
};

const PARQUET_URL = '/data/collisions.parquet';
const PARQUET_NAME = 'collisions.parquet';

let dbPromise: Promise<duckdb.AsyncDuckDB> | null = null;

async function boot(): Promise<duckdb.AsyncDuckDB> {
  const bundle = await duckdb.selectBundle(BUNDLES);
  const worker = new Worker(bundle.mainWorker!);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);

  // Fetch the committed Parquet and hand the whole file to DuckDB's virtual FS.
  // At this size, loading the entire file into memory is fine.
  const res = await fetch(PARQUET_URL);
  if (!res.ok) throw new Error(`fetch ${PARQUET_URL}: ${res.status} ${res.statusText}`);
  await db.registerFileBuffer(PARQUET_NAME, new Uint8Array(await res.arrayBuffer()));

  const conn = await db.connect();
  await conn.query(
    `CREATE VIEW collisions AS SELECT * FROM read_parquet('${PARQUET_NAME}')`,
  );
  await conn.close();
  return db;
}

/** Lazily boots DuckDB once; every caller shares the same instance. */
export function getDb(): Promise<duckdb.AsyncDuckDB> {
  return (dbPromise ??= boot());
}

/** Runs a query and returns rows as plain objects. */
export async function query(sql: string): Promise<Record<string, unknown>[]> {
  const db = await getDb();
  const conn = await db.connect();
  try {
    const table = await conn.query(sql);
    return table.toArray().map((row) => row.toJSON() as Record<string, unknown>);
  } finally {
    await conn.close();
  }
}
