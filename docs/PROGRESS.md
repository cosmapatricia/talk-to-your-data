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
- **Git** — plan → data pipeline → browser loader → snippets + golden set → Worker/loop,
  all committed and pushed to `origin/main`. Pushing works from the agent shell (token in
  `wincred`).

## Next

1. **Smoke-test the live loop** — `wrangler login`, run both dev commands, ask a golden
   question, confirm sensible SQL + rendered table. (User step — needs Cloudflare auth.)
2. **Build + attack the validator** — replace the `src/validate.ts` placeholder with the
   AST/parser SELECT-only guard + banned-function walk; sandbox backstop; honest bypass
   table. This is the seam already wired between Generate and Run.
3. **Full golden harness** — compare the model's SQL result to the reference results in
   `golden-expected.json`, context-on vs context-off (the Worker already accepts
   `withContext`); paste the pass/fail table into `VERIFICATION.md`.

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
