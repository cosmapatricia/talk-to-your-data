import { query } from './db';
import schema from '../shared/schema.json';

const statusEl = document.getElementById('status')!;
const inputEl = document.getElementById('q') as HTMLInputElement;
const runEl = document.getElementById('run') as HTMLButtonElement;
const outEl = document.getElementById('out')!;

const collisions = schema.tables.find((t) => t.name === 'collisions');
const expectedRows = collisions?.row_count ?? 0;

// DuckDB returns BIGINT columns as JS BigInt, which JSON.stringify can't serialise.
function render(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2);
}

async function run(sql: string): Promise<void> {
  outEl.textContent = 'Running…';
  try {
    outEl.textContent = render(await query(sql));
  } catch (err) {
    outEl.textContent = `Error: ${(err as Error).message}`;
  }
}

async function main(): Promise<void> {
  try {
    // Smoke test: the browser must see the same file schema.json describes.
    const rows = await query('SELECT count(*)::INT AS n FROM collisions');
    const n = Number(rows[0].n);
    const match = n === expectedRows ? '✓ matches schema.json' : `✗ expected ${expectedRows}`;
    statusEl.textContent = `Ready — collisions: ${n.toLocaleString('en-GB')} rows (${match})`;
  } catch (err) {
    statusEl.textContent = `Failed to load DuckDB-WASM: ${(err as Error).message}`;
    return;
  }

  inputEl.disabled = false;
  runEl.disabled = false;
  inputEl.value = 'SELECT collision_severity, count(*) AS n FROM collisions GROUP BY 1 ORDER BY 1';

  const submit = () => run(inputEl.value);
  runEl.addEventListener('click', submit);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
}

void main();
