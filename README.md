# talk-to-your-data

Ask questions about UK road-safety collisions in plain English and get a table back.
A Cloudflare Worker turns the question into DuckDB SQL using only *metadata* about the
dataset (schema + curated snippets); the SQL is shown, is editable, and runs locally in
the browser via DuckDB-WASM. **The LLM never sees a row of data.**

## Prerequisites

- **Node 18+** and npm.
- A **free Cloudflare account** — the SQL generator uses the Workers AI binding, so the
  Worker must be authenticated. No API key or paid plan is required.

`wrangler` is a local dev dependency (not installed globally), so always call it with
`npx` — a bare `wrangler ...` will report "not recognized". Authenticate once:

```bash
npm install
npx wrangler login        # opens a browser to authorize; or set CLOUDFLARE_API_TOKEN
```

> First time only: Cloudflare may ask you to confirm your account email and to register a
> free `workers.dev` subdomain (dashboard → **Workers & Pages**) before `wrangler dev`
> will start. Both are one-time.

## Run it (two terminals)

```bash
# Terminal 1 — the Worker (SQL generation via Workers AI). Needs the login above.
npm run worker      # = npx wrangler dev, serves the API on http://127.0.0.1:8787

# Terminal 2 — the app
npm run dev         # vite, serves the page on http://localhost:5173
```

Open **http://localhost:5173**. Vite proxies `/api/*` to the Worker, so the browser
sees one origin (no CORS). The status line should read
`Ready — collisions: 101,525 rows (✓ matches schema.json)`.

Type a question → **Generate SQL** → the proposed SQL appears (editable) with a
one-line rationale → **Run SQL** runs it in DuckDB-WASM and paints the table.

## Bindings, env, model

- **Binding:** `AI` (Workers AI) — declared in `wrangler.jsonc`. No secret to set.
- **Model ID:** `@cf/meta/llama-3.1-8b-instruct-fast` (in `worker/generate-sql.ts`). It
  sits behind a `SqlProvider` seam — swapping to a frontier model behind a key is a
  one-implementation change.

## Example questions that work

1. How many fatal collisions were there?
2. How many serious or fatal collisions happened in fog?
3. How many collisions occurred in each month?
4. How many collisions happened on wet or damp roads versus dry roads?
5. What is the average number of casualties per collision, by severity?
6. How many collisions happened at each speed limit?
7. How many collisions happened in darkness?
8. What share of collisions in urban areas were fatal?
9. How many collisions happened on each day of the week?
10. Which weather condition had the most collisions?

## Data

`public/data/collisions.parquet` and `shared/schema.json` are committed, so a clean
clone needs no download. To rebuild them from the DfT source (Open Government Licence):
`npm run prepare-data`. Raw CSVs land in `data/raw/` (gitignored).

## Verification

`npm run verify-golden` runs the golden-set reference SQL (`shared/golden.json`) against
the committed Parquet and writes `shared/golden-expected.json`.

## Layout

- `worker/` — Cloudflare Worker: `POST /api/generate-sql` → `{ sql, rationale }`.
- `src/` — the page: DuckDB-WASM loader, the question→SQL→table loop, a validator seam.
- `shared/` — `schema.json` (the only dataset metadata the Worker sees), `snippets.json`
  (retrieval context), `golden.json` (verification), `types.ts`.
- `scripts/` — `prepare-data.mjs`, `verify-golden.mjs`.

See `PLAN.md` for design decisions and `docs/PROGRESS.md` for current status.
