# PLAN

_Committed before any application code. This is the plan I started from; a divergence log at the bottom records where I changed my mind._

## What I'm building

A single-page app where you type a question in English, a Cloudflare Worker turns it into DuckDB SQL using only *metadata* about the dataset, and that SQL runs in the browser against a Parquet file via DuckDB-WASM. The generated SQL is shown, is editable, and re-runs on demand. The LLM never receives a single row.

Concretely:

- **Frontend:** Vite + React + TypeScript. Input box, generated-SQL panel (editable), results table, and explicit loading / error / empty / success states. DuckDB-WASM loads one Parquet file once and queries it locally.
- **Worker:** one main endpoint, `POST /api/generate-sql`, that takes `{ question }`, assembles context (schema snapshot + curated snippets), calls the LLM, and returns `{ sql, rationale }`. The API key lives in a Worker secret; the browser never sees it.
- **Dataset:** UK road safety **collisions, single year 2025** — one table (~19MB CSV, a few MB as Parquet). Sourced from GOV.UK "Road safety open data" (Open Government Licence). Chosen deliberately over NYC taxi for two reasons: (1) every categorical column is a *coded integer* whose meaning lives in a separate data guide, so context is load-bearing rather than decorative — this gives the cleanest possible demonstration that retrieval improves the SQL; (2) the vehicles and casualties tables ship alongside and join on the collision reference, so the "add joins across tables" curveball I expect in the conversation is backed by real data rather than hand-waving.
- **Validator:** a parse-based guard that permits a single read-only statement and rejects everything else, backed by a read-only DuckDB connection with no filesystem/network extensions loaded.

## What I'm deliberately not building

- **Multi-table joins in v1.** Collisions-only on purpose, to keep the five hours tight. The vehicles/casualties tables are downloaded and sitting there, so this is a *staged* cut, not a missing capability — I can wire a join live if asked, and I have a clear story for what changes (schema snapshot grows, snippets must describe the join keys, the prompt has to disambiguate which table a question targets).
- **All five "finish early" extensions** (multi-step queries, learning from corrections, semantic layer, ask-twice, follow-ups). The brief says attempting these at the cost of verification loses more than it earns. Not touching them until the golden set runs and the known-failures list is honest.
- **True vector retrieval (Vectorize).** With one dataset the snippet corpus is ~15–20 items and fits in the prompt wholesale. I'll build context injection so it *could* become embedding-based selection later, but I'm not standing up a vector DB to select from twenty snippets. First thing I'd add if the corpus grew; Vectorize is where it would go.
- **Auth, persistence, conversation memory, charts.** Out of scope for the timebox.
- **Server-side query execution.** Not an omission — it's the point. Rows live only in the browser, enforced by there being no code path that sends them anywhere.

## The riskiest part, and how I find out early

Two risks, different in kind.

**Highest severity if I get it wrong: the validator.** A SELECT-only guard sounds trivial and isn't — DuckDB has read-*shaped* statements that aren't harmless (`COPY … TO` writes files, `ATTACH` mounts databases, `INSTALL`/`LOAD` pull extensions, `read_csv('https://…')` and friends reach the network). A regex will miss these. My real backstop isn't the regex, it's the sandbox: DuckDB-WASM on a read-only connection, httpfs never loaded, only the one Parquet file registered — so even a validator bypass has nothing to write to and nowhere to call out. **De-risk on day one:** before building the validator, I open a read-only connection and fire `COPY … TO`, `ATTACH`, and `INSTALL httpfs` at it, and confirm they fail by construction. If the sandbox holds, the validator becomes defense-in-depth plus a readable error message, not the sole line of defence. Confirming that reframing early is the single most important thing I do first — if it *doesn't* hold, this whole section changes.

**Least understood / hardest to get confidence in: semantic correctness.** SQL that parses, runs, returns a tidy table, and answers the wrong question. The coded columns make this sharper here: `accident_severity = 2` means *serious*, not *fatal* — a query can look right, run clean, and quietly count the wrong thing. There's no clean automated oracle for "did it understand the intent." **De-risk early:** before writing the prompt, I hand-write reference SQL for three golden questions so I feel where the ambiguity lives (which severity code is fatal, how nulls/`-1` "unknown" codes behave, date handling). Those ambiguities become the seed of both my snippets and my golden set, and they tell me how much of the data guide the model actually needs.

## How I'll know it works

- **Golden set (~10 questions)** with a hand-written reference SQL and expected result shape/value for each. A small script runs each question through the Worker, validates and executes the returned SQL in DuckDB, and compares to the reference. Output pasted into `VERIFICATION.md` as a pass/fail table.
- **Retrieval A/B.** The same golden questions run twice: once with full context (schema + snippets from the data guide), once with bare schema only. Because the columns are coded, the bare-schema run should *fail or guess* on anything involving severity, road type, weather, etc. — making this the strongest evidence I can give that context improves the SQL. Delta table in `VERIFICATION.md`.
- **Validator attack suite.** A list of malicious inputs (`DROP TABLE`, stacked statements, CTE-wrapped writes, comment-obfuscated payloads, `COPY … TO`, `ATTACH`, `read_csv` over URL, `PRAGMA`/`SET`) asserted to be blocked, plus the ones I *can't* block, documented honestly.
- **Semantic correctness:** result-equivalence against reference SQL for the golden set, plus manual review of the model's one-line rationale as a cheap intent check. I expect to be honest in `VERIFICATION.md` that this is partial.

## Data handling

- **Convert once, commit the Parquet.** I download the collisions-2025 CSV and the data guide (.xlsx) from GOV.UK, convert the CSV to Parquet once locally with DuckDB (`COPY (SELECT * FROM read_csv(...)) TO 'collisions.parquet'`), and commit the ~few-MB Parquet. A `scripts/prepare-data` file documents provenance and makes the Parquet reproducible, but the reviewer never runs it — they get the committed file. This removes a network fetch from the clone path, which is the safest way to hit the ten-minute bar.
- **Serve as a static asset**, fetched on load and handed to DuckDB-WASM via `registerFileBuffer` (whole file into memory — fine at this size). This fetch is one of the required loading states; the input box stays disabled until the data is registered so the first query can't race the load.
- **Schema snapshot** is generated from the Parquet at build time (`DESCRIBE`), written to `schema.json`, and committed. The Worker imports it and never touches the Parquet — reinforcing that the Worker only ever sees metadata.

## Assumptions

- **The reviewer needs an LLM key.** Biggest threat to the ten-minute-clone bar. Mitigation: default to a model behind a Worker secret with dead-simple setup docs, plus a fallback (Workers AI as a no-extra-key path, or a recorded-response mode) so the app is explorable without my paid key. I'll settle external-vs-Workers-AI once I've measured SQL quality on the coded columns. **Assumed:** reviewer has a Cloudflare account and `wrangler` (fair for a Cloudflare take-home).
- **Single year, not five.** GOV.UK flags a severity-reporting change (injury-based reporting shifted reported severity for some forces) that breaks cross-year comparability. Using 2025 alone sidesteps it. **Assumed** a single year is enough to demonstrate the system; noted as a limitation for any "trend over time" question.
- **Coded values in the results table.** A user sees `accident_severity = 1`, not "Fatal". **Assumed** acceptable for v1; options are to live with it, have the model decode via `CASE`, or decode in the display layer. Named as a known limitation rather than discovered live.
- **"Answer as a table."** Every result renders as a table; a scalar is a 1×1 table. No auto-charting.
- **English input only. Single reviewer, local only** — no deploy target, no multi-user concerns.

## Divergence log

_(Where I left this plan and what changed my mind.)_

- **Dataset: NYC taxi → UK road safety collisions.** Initial draft assumed taxi at "~40MB." On checking, a single taxi month sits at the top of the size band and can exceed 50MB, while road-safety collisions is smaller *and* — because every categorical is coded — gives a far stronger retrieval-improves-SQL demonstration and real relational tables for the joins conversation. Changed the dataset, the retrieval section, and the scope framing accordingly.
- **Data shipping: download-script → commit the Parquet.** The draft assumed a setup-time download to keep the repo light. At a few MB Parquet that's unnecessary friction on the clone path; committing the file is more robust for the ten-minute bar. Kept the conversion script for provenance only.
- …
