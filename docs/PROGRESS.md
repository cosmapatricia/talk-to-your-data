# Progress & Handoff

A running snapshot of where the build is and what's next, so a resumed or fresh
session (or a `git pull`) lands in the right place. `PLAN.md` holds the *decisions*;
this file holds the *state*.

_Last updated: 2026-08-14._

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
- **Git** — plan → data pipeline → browser loader, all committed and pushed to
  `origin/main`. Pushing works from the agent shell (token seeded in `wincred`).

## Next — open fork

Pick one:

1. **Snippets + golden-set reference SQL** _(recommended — the named-risk de-risk)._
   - Author 10–30 retrieval snippets from `data/raw/data-guide-2025.xlsx`: severity /
     weather / road-surface code maps, date handling, KPI definitions, a few worked
     question→SQL examples.
   - Hand-write the ~10 golden questions (sketched in `PLAN.md` §3) as reference SQL,
     run them against the browser / DuckDB to capture expected results.
   - Falls out of this: the validator's table/column allow-list (from `schema.json`).
2. **Worker + `generateSQL()` loop** — close question→SQL→table end to end first,
   snippets after.

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
