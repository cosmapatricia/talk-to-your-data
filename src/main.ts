import { query } from './db';
import { validateSql } from './validate';
import schema from '../shared/schema.json';
import codes from '../shared/codes.json';
import type { GenerateResult } from '../shared/types';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const statusEl = el('status');
const questionEl = el<HTMLInputElement>('question');
const generateEl = el<HTMLButtonElement>('generate');
const rationaleEl = el('rationale');
const sqlEl = el<HTMLTextAreaElement>('sql');
const runEl = el<HTMLButtonElement>('run');
const msgEl = el('msg');
const resultsEl = el('results');

const expectedRows = schema.tables.find((t) => t.name === 'collisions')?.row_count ?? 0;

function setMsg(text = ''): void {
  msgEl.textContent = text;
}

function clearResults(): void {
  resultsEl.innerHTML = '';
}

// Coded-column decode maps (integer code -> label) from the DfT guide. Display layer
// only: the SQL still uses the integer codes, the table reads in English.
const codeMaps = codes.columns as Record<string, Record<string, string>>;

const escapeHtml = (s: string) =>
  s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));

// A cell's text: decode a coded column to "code — label"; BIGINT arrives as JS BigInt so
// stringify safely; escape because we build the table via innerHTML.
function cellText(col: string, value: unknown): string {
  if (value === null || value === undefined) return '';
  const raw = String(value);
  const label = codeMaps[col]?.[raw];
  return escapeHtml(label ? `${raw} — ${label}` : raw);
}

function renderTable(rows: Record<string, unknown>[]): void {
  clearResults();
  if (rows.length === 0) {
    resultsEl.innerHTML = '<div id="empty">No rows.</div>';
    return;
  }
  const cols = Object.keys(rows[0]);
  const thead = `<tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr>`;
  const tbody = rows
    .slice(0, 500)
    .map((r) => `<tr>${cols.map((c) => `<td>${cellText(c, r[c])}</td>`).join('')}</tr>`)
    .join('');
  const note = rows.length > 500 ? `<div id="empty">Showing first 500 of ${rows.length} rows.</div>` : '';
  resultsEl.innerHTML = `<table>${thead}${tbody}</table>${note}`;
}

async function onGenerate(): Promise<void> {
  const question = questionEl.value.trim();
  if (!question) return;
  setMsg();
  rationaleEl.textContent = 'Generating…';
  generateEl.disabled = true;
  try {
    const res = await fetch('/api/generate-sql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    const data = (await res.json()) as GenerateResult & { error?: string };
    if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
    sqlEl.value = data.sql;
    rationaleEl.textContent = data.rationale ? `Rationale: ${data.rationale}` : '';
  } catch (err) {
    rationaleEl.textContent = '';
    setMsg(`Generation failed: ${(err as Error).message}`);
  } finally {
    generateEl.disabled = false;
  }
}

async function onRun(): Promise<void> {
  const sql = sqlEl.value.trim();
  if (!sql) return;
  setMsg();

  // Validator seam — currently a placeholder; the real guard slots in here next.
  const verdict = validateSql(sql);
  if (!verdict.ok) {
    clearResults();
    setMsg(`Blocked by validator: ${verdict.message ?? 'not a read-only query'}`);
    return;
  }

  resultsEl.innerHTML = '<div id="empty">Running…</div>';
  try {
    renderTable(await query(sql));
  } catch (err) {
    clearResults();
    setMsg(`Query error: ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  try {
    const rows = await query('SELECT count(*)::INT AS n FROM collisions');
    const n = Number(rows[0].n);
    const match = n === expectedRows ? '✓ matches schema.json' : `✗ expected ${expectedRows}`;
    statusEl.textContent = `Ready — collisions: ${n.toLocaleString('en-GB')} rows (${match})`;
  } catch (err) {
    statusEl.textContent = `Failed to load DuckDB-WASM: ${(err as Error).message}`;
    return;
  }

  questionEl.disabled = false;
  generateEl.disabled = false;
  runEl.disabled = false;
  questionEl.value = 'How many serious or fatal collisions happened in fog?';

  generateEl.addEventListener('click', onGenerate);
  runEl.addEventListener('click', onRun);
  questionEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onGenerate();
  });
}

void main();
