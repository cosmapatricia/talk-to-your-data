# Verification — how I know it works

A living document. Sections marked _(pending automation)_ are exercised manually today and
will be filled by the golden harness (model SQL vs. reference SQL, context-on/off).

## 1. Golden set

`shared/golden.json` holds 12 questions, each with **hand-authored reference SQL that is
the oracle** — the harness runs the model's SQL and the reference SQL against DuckDB and
compares result sets. `scripts/verify-golden.mjs` (`npm run verify-golden`) runs every
reference query against the committed Parquet and writes `shared/golden-expected.json`.
All 12 run clean. Reference results:

| id | kind | has_example | expected |
| --- | --- | --- | --- |
| fatal-count | exact | yes | 1,453 |
| fog-serious-or-worse | exact | yes | 110 |
| collisions-by-month | exact | yes | 12 rows (Jan = 8,163) |
| wet-vs-dry | exact | no | wet 22,312 / dry 75,679 |
| avg-casualties-by-severity | exact | no | 1.6366 / 1.3422 / 1.2245 |
| collisions-by-day-of-week | exact | no | 7 rows (Sun = 11,197) |
| urban-fatal-share | exact | no | 0.007759 |
| collisions-by-speed-limit | exact | no | 6 rows (20mph = 20,045) |
| darkness-count | exact | no | 28,695 |
| collisions-in-rain | exact | no | 11,110 |
| fatal-wet-darkness | exact | no | 221 |
| weather-with-most-collisions | fuzzy | no | top = code 1 "Fine" (83,405) |

**`has_example`** records whether a near-verbatim worked example exists in
`shared/snippets.json`. The 8 `has_example: false` questions force the model to *compose*
SQL from the code maps rather than copy an example — the stronger arm of the A/B.

**Golden harness — live run** (`npm run golden-harness`, model `@cf/meta/llama-3.1-8b-instruct-fast`).
Runs every question through the live Worker and compares to the reference, context-on vs
context-off. The model is non-deterministic, so this is a snapshot; re-run for a fresh one.

| id | kind | has_example | context-on | context-off |
| --- | --- | --- | --- | --- |
| fatal-count | exact | yes | PASS | FAIL |
| fog-serious-or-worse | exact | yes | PASS | FAIL |
| collisions-by-month | exact | yes | PASS | SQL-ERR |
| wet-vs-dry | exact | no | FAIL | FAIL |
| avg-casualties-by-severity | exact | no | PASS | FAIL |
| collisions-by-day-of-week | exact | no | PASS | SQL-ERR |
| urban-fatal-share | exact | no | PASS | FAIL |
| collisions-by-speed-limit | exact | yes | PASS | PASS |
| darkness-count | exact | no | PASS | FAIL |
| collisions-in-rain | exact | no | PASS | FAIL |
| fatal-wet-darkness | exact | no | PASS | FAIL |
| weather-with-most-collisions | fuzzy | no | FUZZY | FUZZY |

**Retrieval A/B (11 graded, fuzzy excluded):** context-on **10/11 PASS**, context-off
**1/11 PASS**; retrieval improved **9** questions. That is "retrieval demonstrably improves the
SQL over no context" in one number — with the code-map context the model composes correct SQL
almost everywhere; strip the context and it fails almost everywhere, because the codes appear
nowhere in the schema. (The one question that passes without context, `collisions-by-speed-limit`,
is the one where the values are literal mph rather than an arbitrary code.)

Two concrete findings from this run:

- **`wet-vs-dry` fails context-on — a semantic case, not a bug.** The model answered a *broader*
  question: `SELECT road_surface_conditions, count(*) ... GROUP BY 1` returns all five surface
  categories rather than the two-number wet-vs-dry comparison the reference isolates. The wet and
  dry counts are present, but the shape differs, so strict `exact` grading marks it FAIL. Right
  data, slightly broader question — see §4.6 on structure-sensitive grading.
- **Context-off breaks on `collision_index` — vivid A/B evidence.** With no context the model
  invented `WHERE collision_index != -1`, misapplying the "-1 = missing" sentinel pattern to the
  collision *identifier* (a mixed alphanumeric VARCHAR like `2025440199184`); DuckDB then errors
  converting the string to an integer. The snippets tell the model `collision_index` is an id, not
  a coded column — without them it misapplies the rule and produces invalid SQL. This also
  vindicates the forced-VARCHAR decision in the data pipeline.

Full per-question detail (including the model SQL for each arm) is in `shared/golden-results.json`.

**Model capability vs. pipeline.** The default model is the small
`@cf/meta/llama-3.1-8b-instruct-fast`, so in principle some failures could be model capability
rather than pipeline (retrieval / prompt / schema). In practice it composed correctly on 10/11
graded questions with context, and the one context-on failure (`wet-vs-dry`) is a
broader-answer / shape difference, not a capability gap. I did **not** swap in a frontier model
to isolate capability from pipeline — the `generateSQL()` seam makes it a one-line change, but I
did not run it, so where that boundary falls is reasoned, not measured.

## 2. Semantic correctness — right table, wrong question

A query can execute cleanly, return a tidy table, and answer a subtly different question
than the user meant. Concrete case from this dataset, question
_"Which weather condition had the most collisions?"_:

- The correct-looking answer is **code 1, "Fine no high winds" (83,405)**. It runs clean and
  is literally correct — but if the user meant _"which weather is most dangerous,"_ it is the
  **wrong answer**. Most collisions happen in fine weather simply because most driving happens
  in fine weather. Raw counts are not risk.
- This question is tagged `fuzzy` precisely because there is no single ground truth. Observed
  divergence between my reference and the 8b: the model additionally excluded code `9`
  (Unknown), not just `-1`, and added `LIMIT 1`. Both are defensible judgment calls — which is
  exactly why exact result-set matching is the wrong criterion here and the question is graded
  on shape plus the top row.

Approach: hand-authored reference SQL catches "answered the wrong question" for the exact
questions; for genuinely ambiguous ones, we grade on shape + a spot-checked value and label
them fuzzy rather than pretend a single answer exists.

That approach only covers the golden set — it is an *offline* check. For an arbitrary user
question there is no reference SQL, so nothing automatically flags a clean-but-wrong answer at
runtime. The runtime defence is **transparency, not automation**: the generated SQL is shown,
editable, and re-runnable with a one-line rationale, so a user can read it and catch a
wrong-question answer themselves (e.g. notice that a "most collisions" query returned fine
weather). That is a partial mitigation, not a solution — I did not build an automated semantic
guard (LLM-as-judge, ask-twice / self-consistency) for general questions. **How far I got:**
reference-SQL comparison + fuzzy labelling for the golden set, and inspectable SQL + rationale for
everything else; general semantic-correctness detection remains unsolved.

## 3. Attacking my own validator

The guard (`src/validate.ts`) is defense-in-depth: DuckDB's own parser
(`json_serialize_sql`, which serializes **only** SELECT statements) is the load-bearing
check, plus an AST walk that rejects file/network functions by name. `scripts/attack-validator.mjs`
(`npm run attack-validator`) runs **31 adversarial cases; all match expectation.** Confirmed on
the real browser path too: `DROP TABLE collisions` is blocked with a readable message and a
normal query runs — so `json_serialize_sql` is available in DuckDB-WASM and the guard is not
Node-only.

| Attack class | Example | Result | Caught by |
| --- | --- | --- | --- |
| DDL / DML | `DROP TABLE collisions`, `DELETE …`, `INSERT …` | blocked | parser errors (not a SELECT) |
| Side-effect statements | `COPY … TO`, `ATTACH`, `INSTALL`, `LOAD`, `PRAGMA`, `SET`, `CALL` | blocked | parser errors (not a SELECT) |
| Stacked (non-SELECT) | `SELECT 1; DROP TABLE collisions` | blocked | parser errors on the DROP |
| Stacked (all SELECT) | `SELECT 1; SELECT 2` | blocked | **statement-count check** (see below) |
| Comment-hidden stacked | `SELECT 1 -- x⏎; DROP …`, `SELECT 1 /* ; DROP */; DROP …` | blocked | parser errors |
| File / network functions | `read_csv('http://…')`, `read_parquet`, `read_text`, `read_blob`, `glob` | blocked | AST banned-function walk |
| Function nested in subquery/CTE | `SELECT (SELECT count(*) FROM read_csv('http://…'))` | blocked | AST walk recurses |
| Legitimate queries | plain SELECT, CTE, subquery, FILTER/GROUP BY, comments, trailing `;` | allowed | — |

**Why two checks, not one (`SELECT 1; SELECT 2`).** Most stacked attacks are caught because a
later statement is non-SELECT and `json_serialize_sql` errors. But two *SELECTs* both serialize
fine (no error) — the parser returns a statement array of length 2. That case is caught only by
the separate **"exactly one statement"** count check. `SELECT 1; SELECT 2` is not itself
dangerous (both read-only), but permitting multiple statements is a door you don't want open,
and enforcing a single statement is cheap and closes it. It's a clean illustration of why the
checks are layered rather than collapsed into one.

**What slips through, and why the sandbox still holds.** The banned-function list is a
**denylist, and not exhaustive by construction** — a file- or network-reading function I didn't
enumerate could pass the AST walk. That gap is covered by the backstop: DuckDB-WASM runs an
in-memory database with **`httpfs` never loaded** (so there is no network egress at all) and a
virtual filesystem that holds **only the one registered Parquet** (so there is no arbitrary file
to read). The read-only property is enforced by the validator (SELECT-only) plus those two facts —
**not** a connection-level `read_only` flag: the database is in-memory and ephemeral, so any write
goes nowhere on the host, and read-only mode would in fact reject the startup `CREATE VIEW`. In other words, even a validator bypass has nothing to reach: no network, and nothing
on disk but the data the app already loaded. The parser + AST walk give readable, early rejection
in the UI; the sandbox is what makes a miss non-fatal.

To be precise about what is tested vs. reasoned: the parser + AST walk are the **tested** layer
(31-case suite + the in-browser DROP block). The sandbox backstop is a **design argument** from
the architecture — `httpfs` is never loaded and the virtual FS holds only the registered file —
**not** an exhaustively tested one. I did not run every DuckDB file/network function against the
WASM sandbox, and DuckDB can in some builds attempt to autoload an extension on first use, so the
honest claim is "by construction there is nothing to reach," not "every function was verified to
fail."

## 4. Known failures & fragilities

At least three things that are broken, fragile, or wrong, each with a diagnosis.

1. **Truncated model JSON.** The 8b occasionally returns its JSON cut off mid-output (observed:
   a complete `sql` field followed by a rationale truncated mid-word, so the object had no
   closing brace). _Diagnosis:_ the model stops emitting before finishing the object; the
   strict `{…}` parse then fails even though the SQL is present. _Mitigation:_ the parser now
   falls back to extracting the `sql` field directly, so a truncated *rationale* no longer loses
   a correct *SQL*. _Residual failure:_ if the truncation lands **inside the SQL string** itself,
   there is no complete SQL to recover and generation fails — the user retries. Non-deterministic;
   a retry usually succeeds.

2. **Deprecated model id, caught only at runtime.** The initial hardcoded model
   `@cf/meta/llama-3.1-8b-instruct` had been deprecated (2026-05-30). It type-checked and built
   fine and failed only on the first live call (`5028: … was deprecated`). _Diagnosis:_ an
   external identifier the code can't verify offline. _Fix:_ switched to
   `@cf/meta/llama-3.1-8b-instruct-fast`; the provider seam makes the swap one line. (See
   `AI-USAGE.md`.)

3. **Validator denylist is not exhaustive.** As in §3, a novel file/network function could pass
   the AST walk. _Diagnosis:_ a denylist can only block the functions I thought to name.
   _Mitigation:_ this is one of three layers — DuckDB's parser still rejects every non-SELECT
   statement (tested), the denylist blocks the file/network functions I did name, and for one that
   slips through, the WASM sandbox (no `httpfs`, an in-memory filesystem holding only the
   registered Parquet) is the backstop — a reasoned one, not exhaustively tested (see §3).

4. **Single-year data — no cross-year trends.** The dataset is 2025 only (a deliberate cut; DfT's
   severity-reporting change breaks cross-year comparability). _Diagnosis:_ any "trend over the
   years" question cannot be answered; the model may still write plausible SQL that returns a
   single year's data, which is misleading. Not yet guarded — a candidate known-failure to
   surface to the user.

5. **Fuzzy questions have no single ground truth (§2).** "Most collisions" ≠ "most dangerous";
   the honest answer is to grade on shape and flag the interpretation gap rather than assert one
   result is correct.

6. **Exact-match grading is structure-sensitive.** A model answer that is correct but shaped
   differently than the reference is marked FAIL by exact result-set comparison — e.g.
   `wet-vs-dry`, where the model returned all five surface categories as rows instead of the
   reference's two FILTER columns (§1). _Diagnosis:_ strict equality can't distinguish "wrong"
   from "differently shaped but valid." _Mitigation:_ the `shape`/`fuzzy` kinds exist for
   questions with no single canonical form; exact FAILs are treated as prompts for manual review,
   not automatic verdicts. A future harness could compare on a canonicalised value set rather
   than row/column structure.
