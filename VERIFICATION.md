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

**Manual live results (8b, `@cf/meta/llama-3.1-8b-instruct-fast`)** — pending the automated
harness, these were checked by hand and all matched the reference:

- `fog-serious-or-worse` → `... collision_severity <= 2 AND weather_conditions = 7` = 110 ✓
- `collisions-by-speed-limit` → correct, including the `NOT IN (-1, 99)` sentinel exclusion ✓
- `collisions-in-rain` → `weather_conditions IN (2, 5)` = 11,110 ✓ (no worked example; composed from the weather map)
- `fatal-wet-darkness` → three maps combined = 221 ✓ (wrote darkness as an OR-chain, equivalent to `IN (4,5,6,7)`)
- `darkness-count` → `light_conditions IN (4,5,6,7)` = 28,695 ✓

The model composed correctly even on `has_example: false` questions — evidence that retrieval
of the **code maps** (not just example-copying) improves the SQL.

**Retrieval A/B _(pending automation)_.** The Worker accepts a `withContext` flag; the
harness will run every golden question with context and with bare schema only. Expectation:
the no-context arm fails or guesses on anything involving a code (severity/weather/light/…),
because those codes appear nowhere in the schema.

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

## 3. Attacking my own validator

The guard (`src/validate.ts`) is defense-in-depth: DuckDB's own parser
(`json_serialize_sql`, which serializes **only** SELECT statements) is the load-bearing
check, plus an AST walk that rejects file/network functions by name. `scripts/attack-validator.mjs`
(`npm run attack-validator`) runs **31 adversarial cases; all match expectation.**

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
enumerate could pass the AST walk. That gap is covered by the backstop: DuckDB-WASM runs on a
read-only connection with **`httpfs` never loaded** (so there is no network egress at all) and a
virtual filesystem that holds **only the one registered Parquet** (so there is no arbitrary file
to read). In other words, even a validator bypass has nothing to reach: no network, and nothing
on disk but the data the app already loaded. The parser + AST walk give readable, early rejection
in the UI; the sandbox is what makes a miss non-fatal.

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
   the AST walk. _Diagnosis:_ denylists can't enumerate the future. _Mitigation:_ the read-only
   WASM sandbox (no `httpfs`, single registered file) means a bypass has nothing to reach; the
   denylist is the readable-error layer, not the security boundary.

4. **Single-year data — no cross-year trends.** The dataset is 2025 only (a deliberate cut; DfT's
   severity-reporting change breaks cross-year comparability). _Diagnosis:_ any "trend over the
   years" question cannot be answered; the model may still write plausible SQL that returns a
   single year's data, which is misleading. Not yet guarded — a candidate known-failure to
   surface to the user.

5. **Fuzzy questions have no single ground truth (§2).** "Most collisions" ≠ "most dangerous";
   the honest answer is to grade on shape and flag the interpretation gap rather than assert one
   result is correct.
