# AI Usage

Short and honest, per the brief. This is a living note; I'll add to it as the build
continues.

## Tools

- **Claude (agentic coding assistant)** — used throughout: to pressure-test the plan
  before writing it, scaffold the data pipeline and the DuckDB-WASM loader, author the
  retrieval snippets and golden set, and build the Worker + loop. Most code in this repo
  was written by the agent under my direction.

## What I handed over wholesale

- Boilerplate and glue: the Vite/wrangler config, the DuckDB-WASM bootstrap, the
  `{sql, rationale}` plumbing, the HTML/CSS.
- The first pass of the retrieval snippets and golden-set reference SQL — but *not*
  blindly: the code maps were extracted from the actual DfT data guide with a throwaway
  DuckDB script, and every reference query was run against the committed Parquet before I
  trusted it as an oracle (see `scripts/verify-golden.mjs`).

## What I rejected or rewrote

- **Vector retrieval (Vectorize).** The agent's early instinct was to reach for a vector
  store. I pushed back: at ~20 snippets that fit in the prompt wholesale, that's
  infrastructure for a problem I don't have. We kept retrieval as plain inlining and
  wrote down the conditions under which selection would earn its place (when the snippet
  corpus outgrows the prompt, or the corrections extension is attempted).
- **Risk framing.** I kept my own "highest-severity (validator) vs. least-understood
  (semantic correctness)" split rather than collapsing to a single headline risk.

## The agent being confidently wrong — and how I caught it

Three cases — the first two caught at **runtime**, the third caught by reproducing a report
before trusting it:

1. **A hardcoded model ID that had been deprecated.** The agent set the Workers AI model
   to `@cf/meta/llama-3.1-8b-instruct` with full confidence. That ID was deprecated on
   2026-05-30 — after the model's training cut-off — so it looked correct but wasn't. It
   failed only when I ran the live loop: `5028: ... was deprecated`. Fix: pulled the
   current catalog and switched to `@cf/meta/llama-3.1-8b-instruct-fast`. Lesson: a
   plausible-looking external identifier from an LLM is a guess; verify model/API IDs
   against the live source, don't trust recall.

2. **A parser that assumed the response was a string.** The agent wrote the SQL-response
   parser as `res.response.match(/.../)`, assuming Workers AI returns
   `{ response: string }`. For this model `response` came back as an object, so the first
   real call threw `text.match is not a function`. It type-checked and built fine — the
   wrong assumption was about a runtime shape the types didn't capture. Fix: made the
   parser tolerate every response shape (string, `{response: string}`,
   `{response: {...}}`, or the object directly) and include a snippet of the raw response
   in its error so the next surprise is visible. Lesson: don't assume an external API's
   response shape from one remembered example; handle the variants and surface the raw
   payload on failure.

3. **A phantom bug, documented from a single unverified report.** When I reported that a
   `FILTER` query was "blocked by the validator," the agent immediately wrote it up as a
   *confirmed* bug — a validator false-positive **and** a Node-vs-WASM parser divergence — and
   committed it to `VERIFICATION.md` as a known-failure, *before reproducing it*. It was wrong:
   the block came from stray `"` quotes I had copied around the query (which correctly made it
   invalid SQL); the bare `FILTER` query works fine. Caught when I re-tested the bare query in
   the browser. The agent reverted the phantom and re-investigated properly — running the actual
   `validateSql` — which *did* surface a real false-positive: the validator over-blocks
   `UNION` / `EXCEPT` / `INTERSECT` (known-failure #7). Lesson: the agent will confidently turn
   one data point into a documented "fact"; reproduce a failure through the real code path before
   recording it.

The first two share one failure mode: the agent is fluent and confident about external
contracts (model IDs, response shapes) it can't verify from training, and those slip past
type-checking and builds because they're only wrong at runtime. The third is a related trap —
over-generalising from a single report into a documented fact. The guard against both is the
same: run the real thing, and reproduce the real failure, before trusting or recording it.
