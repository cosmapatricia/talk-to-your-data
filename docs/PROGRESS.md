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
- **Golden set** — `shared/golden.json`: 10 questions with hand-authored reference SQL
  (the oracle), 9 `exact` + 1 `fuzzy`; most require a code map, so they double as the
  retrieval context-on/off A/B. `scripts/verify-golden.mjs` (`npm run verify-golden`)
  runs them against the committed Parquet and writes `shared/golden-expected.json`.
  All 10 run clean (fatal=1,453; fog-serious-or-worse=110; the fuzzy weather one shows
  raw counts crown "Fine" — the count-vs-danger caveat, with a real number).
- **Git** — plan → data pipeline → browser loader → snippets + golden set, all
  committed and pushed to `origin/main`. Pushing works from the agent shell (token in
  `wincred`).

## Next

1. **Worker + `generateSQL()` loop** — Worker endpoint assembles schema snapshot +
   inlined snippets + question, calls Workers AI (Llama 3.x) behind the `generateSQL()`
   seam, returns `{ sql, rationale }`; wire question→SQL→table in the browser, with the
   validator sitting between generate and run.
2. **Build + attack the validator** — AST/parser SELECT-only guard + sandbox; honest
   bypass table.
3. **Full golden harness** — compare the model's SQL result to the reference SQL results
   in `golden-expected.json`, context-on vs context-off; paste the pass/fail table into
   `VERIFICATION.md`.

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
