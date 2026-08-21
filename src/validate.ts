// SQL validator — the guard between "generate" and "run" in the loop.
//
// Defense in depth (PLAN.md, validator section). The load-bearing check is DuckDB's OWN
// parser via `json_serialize_sql`, which serializes ONLY select statements — so any DDL,
// COPY, ATTACH, INSTALL, LOAD, PRAGMA, SET, CALL, or stacked statement (even one hidden
// behind a comment) comes back as an error and is rejected. That leaves one gap:
// file/network functions like read_csv/read_parquet are legal *inside* a SELECT, so we
// also walk the parsed AST and reject any banned function by name. Behind both,
// DuckDB-WASM runs on a read-only connection with httpfs never loaded and a virtual FS
// holding only the one registered Parquet — so even a function that slips the denylist
// has no file to read and no network to reach.

export interface ValidationResult {
  ok: boolean;
  message?: string;
}

/** The shape of DuckDB's json_serialize_sql output (only the parts we read). */
export interface SerializedSql {
  error?: boolean;
  error_message?: string;
  statements?: Array<{ node?: { type?: string } }>;
}

/** Runs DuckDB's json_serialize_sql and returns the parsed AST. Node and WASM share the
 *  same parser, so the same validator runs identically in tests and in the browser. */
export type Serializer = (sql: string) => Promise<SerializedSql>;

// File/network/side-effecting functions that ARE legal inside a SELECT and so slip past
// the "SELECT only" check — these read the filesystem or reach the network. This is a
// denylist (not exhaustive by construction); the read-only WASM sandbox is the backstop.
const BANNED_FUNCTIONS = new Set([
  'read_csv',
  'read_csv_auto',
  'read_parquet',
  'parquet_scan',
  'parquet_metadata',
  'parquet_schema',
  'parquet_file_metadata',
  'parquet_kv_metadata',
  'read_json',
  'read_json_auto',
  'read_json_objects',
  'read_ndjson',
  'read_ndjson_auto',
  'read_ndjson_objects',
  'read_text',
  'read_blob',
  'glob',
  'sniff_csv',
]);

/** Recursively collect every `function_name` in the AST (scalar and table functions). */
function collectFunctionNames(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const child of node) collectFunctionNames(child, out);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'function_name' && typeof value === 'string') out.add(value.toLowerCase());
      else collectFunctionNames(value, out);
    }
  }
}

export async function validateSql(sql: string, serialize: Serializer): Promise<ValidationResult> {
  const trimmed = sql.trim();
  if (!trimmed) return { ok: false, message: 'empty query' };

  let ast: SerializedSql;
  try {
    ast = await serialize(trimmed);
  } catch (err) {
    // json_serialize_sql itself threw (e.g. an outright syntax error it can't represent).
    return { ok: false, message: `not a valid read-only query: ${(err as Error).message}` };
  }

  // Non-SELECT input (DDL / COPY / ATTACH / PRAGMA / SET / INSTALL / LOAD / CALL, or
  // stacked statements) serializes to an error rather than a statement list.
  if (ast.error || !ast.statements || ast.statements.length === 0) {
    return { ok: false, message: 'only a single read-only SELECT query is allowed' };
  }
  if (ast.statements.length !== 1) {
    return { ok: false, message: 'only one statement is allowed' };
  }
  if (ast.statements[0].node?.type !== 'SELECT_NODE') {
    return { ok: false, message: 'only SELECT queries are allowed' };
  }

  const functionNames = new Set<string>();
  collectFunctionNames(ast.statements, functionNames);
  for (const name of functionNames) {
    if (BANNED_FUNCTIONS.has(name)) {
      return { ok: false, message: `disallowed function: ${name}() reads files or the network` };
    }
  }

  return { ok: true };
}
