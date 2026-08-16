# Progress & Handoff

A running snapshot of where the build is and what's next, so a resumed or fresh
session (or a `git pull`) lands in the right place. `PLAN.md` holds the *decisions*;
this file holds the *state*.

_Last updated: 2026-08-16._

## Done

- **Plan** — `PLAN.md` written and committed first, then refined; the divergence log
  records where the plan met the real data (column renames, date-casting bug, etc.).
- **Data pipeline** — `scripts/prepare-data.mjs` converts the DfT road-safety CSVs to
  Parquet with the two silent-corruption traps handled: `collision_index` /
  `collision_ref_no` forced to VARCHAR, and `date`/`time` cast with an explicit format
  (not left to the sniffer). Reviewer never runs it — the artifacts are committed.
- **Committed artifacts** — `public/data/collisions.parquet` (~4 MB) and
  `shared/schema.json` (the schema snapshot: per-table columns + types, grain,
  row_count, date_range; no values).
- **Browser loader** — `src/db.ts` + `src/main.ts` + `index.html`. Boots DuckDB-WASM
  (single-thread eh/mvp bundles, locally bundled by Vite — no CDN, no COOP/COEP),
  fetches the committed Parquet, registers it, creates the `collisions` view.
  **Verified in-browser: 101,525 rows, matches `schema.json`.** Arbitrary SQL is already
  editable and re-runnable in the UI (partial acceptance check met).
- **Retrieval snippets** — `shared/snippets.json`: ~19 hand-authored facts from the
  DfT data guide (severity/weather/road-surface/light/day-of-week code maps, the
  `-1` missing-sentinel convention, speed_limit-is-numeric-mph, date handling, KPI
  definitions, worked question→SQL examples). Inlined wholesale into the prompt.
- **Golden set** — `shared/golden.json`: 12 questions with hand-authored reference SQL
  (the oracle), 11 `exact` + 1 `fuzzy`, each tagged `has_example` (4 true / 8 false).
  `has_example:false` questions have no near-verbatim worked example, so they force the
  model to compose SQL from the code maps — the stronger arm of the context-on/off A/B.
  `scripts/verify-golden.mjs` (`npm run verify-golden`) runs them against the committed
  Parquet and writes `shared/golden-expected.json`. All 12 run clean. Live-tested on the
  8b: it composed rain (`weather IN (2,5)` = 11,110) and fatal-wet-darkness (three maps =
  221) correctly with no example to copy — retrieval doing real semantic work, not just
  copying. Real known-failures will need harder cases (ambiguity, unmentioned sentinels,
  multi-step).
- **Worker + loop** — `worker/`: `POST /api/generate-sql` assembles `schema.json` +
  inlined `snippets.json` + question, calls Workers AI (`@cf/meta/llama-3.1-8b-instruct`)
  behind a `SqlProvider` seam, returns `{ sql, rationale }`. Frontend evolved into the
  full loop: question → Generate → editable SQL + rationale → (validator seam) → Run →
  results table, with states. Dev is two processes — `npm run worker` (wrangler, :8787)
  + `npm run dev` (vite, :5173, proxies /api). README documents it.
  **Validated offline:** typecheck (browser + worker), `vite build`, and
  `wrangler deploy --dry-run` (AI binding recognized) all pass. **NOT yet run live** —
  the Workers AI call needs `wrangler login`; user to smoke-test.
- **Coded-value display** — `shared/codes.json` (29 columns, 1,390 codes, from the DfT
  guide via `npm run build-codes`). The results table decodes coded columns to
  `code — label` (e.g. `1 — Fine no high winds`) at render time; the generated SQL stays
  in raw integer codes (clean + editable). Resolves the coded-value known-limitation from
  PLAN.md via option (c), display-layer decode. HTML-escaped (table built via innerHTML).
- **Validator** — `src/validate.ts`: DuckDB's own parser (`json_serialize_sql`) is the
  load-bearing guard (single SELECT only → rejects DDL/COPY/ATTACH/INSTALL/LOAD/PRAGMA/
  SET/CALL and stacked statements, comment-hidden included), plus an AST walk that rejects
  file/network functions (`read_csv`/`read_parquet`/`read_text`/`read_blob`/`glob`, even
  nested). Wired into Run via `serializeSql` in `db.ts`. `scripts/attack-validator.mjs`
  (`npm run attack-validator`) runs 31 adversarial cases — all match expectation. Backstop
  is the read-only WASM sandbox (no httpfs; VFS holds only the registered Parquet).
  Confirmed in-browser: `DROP TABLE collisions` blocked with a readable message, normal query
  runs — so `json_serialize_sql` is available in DuckDB-WASM (guard runs on the real path).
- **Golden harness** — `scripts/golden-harness.mjs` (`npm run golden-harness`): every question
  through the LIVE Worker, model SQL vs reference, context-on vs context-off; writes
  `shared/golden-results.json`, prints a Markdown table. Live snapshot: context-on **10/11**,
  context-off **1/11**, retrieval improved **9**. Two findings: `wet-vs-dry` "fails" on a broader
  answer (semantic, not a bug); context-off invents `collision_index != -1` and SQL-errors (A/B
  proof). Pasted into `VERIFICATION.md` §1.
- **VERIFICATION.md** — drafted: golden table + A/B, semantic correctness, 31-case validator
  bypass table, 6 known failures with diagnoses.
- **Git** — plan → data pipeline → loader → snippets + golden set → Worker/loop →
  coded-value decode → validator → golden harness + VERIFICATION, all committed and pushed to
  `origin/main`. Pushing works from the agent shell (token in `wincred`).

## Next (polish only — feature-complete)

1. **Time a clean clone to running < 10 min** — the one unmet acceptance check; npm install +
   wasm download is the variable.
2. **Final read-through** of PLAN / README / VERIFICATION / AI-USAGE; optionally re-run
   `npm run golden-harness` for a fresh snapshot, and add a known-failure note for cross-year
   "trend" questions (single-year data).

## Locked decisions (see PLAN.md for the why)

- **Context: inline all snippets** (~15–20 fit wholesale). Embedding/Vectorize is the
  conditional next step if the corpus grows or the corrections extension is attempted.
- **Model: Workers AI (Llama 3.x) to start**, behind a one-function `generateSQL()`
  seam so a frontier model is a config swap. Flag in `VERIFICATION.md` that some
  golden-set failures may be model capability, not pipeline.
- **Validator: defense-in-depth** — AST/parser guard (single read-only SELECT) +
  DuckDB-WASM sandbox + read-only connection; honest bypass table of what slips through.
- **Golden set: hand-authored reference SQL** comparison as the spine, shape-check
  fallback for fuzzy questions (labelled).
- **Risk framing:** validator = highest severity if wrong; semantic correctness =
  least understood / hardest to gain confidence in.
- **Scope cut:** all five extensions + charts + memory cut; follow-up questions the
  single gated stretch, only if core + verification are solid.
- **Stack:** Cloudflare + Vite, minimal, single page + `wrangler dev`; clean clone must
  run locally in under ten minutes (time it before submitting).

## How to resume this session

Run from the directory this session was launched in (`D:\Projects\test`):
`claude --continue` (most recent) or `claude --resume` (picker). Session history is
keyed to the launch directory, not the repo.
